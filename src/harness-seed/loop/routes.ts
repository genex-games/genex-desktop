/**
 * Routes: a judge's session that reached its goal on a stepped clock, kept as the inputs that got
 * there and replayed on every later build of the run. A build that no longer lets the same inputs
 * reach the same goal has regressed somewhere a screenshot cannot see, and the replay names the
 * step where it parted ways.
 *
 * - `distillRoute` (pure): the trace's input and wait steps up to the move after which the studio
 *   verified the goal, mapped onto the preview's input actions; looks are dropped.
 * - `keepRoute`: kept for this run only, on the run and in its journal.
 * - `replayRoutes`: from the evidence pass, on a leased window — seed the page, replay, check the
 *   goal. A route from a session that was not deterministic never fails a check: it is reported.
 *
 * A new module: evidence.ts calls it through a namespace import, so a kept older evidence.ts never
 * needs it and this one never stops it loading.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { HostMethod } from "./host-methods.ts";
import {
  appendInteraction,
  InteractionObjective,
  InteractionSource,
  InteractionStatus,
} from "./interaction-evidence.ts";
import { isRecord } from "./json.ts";
import { PageMethod } from "./page-contract.ts";
import { type Quest, questHolds } from "./quest.ts";
import { CheckKind, CheckWeight } from "./spec.ts";
import { SECOND_MS } from "./time.ts";
import type { AnyRecord, HarnessCtx, Run } from "../types/harness.d.ts";
import type { PreviewInputAction } from "../types/host-api.d.ts";
import type { CheckResult } from "./checks.ts";

/** The longest route kept: a longer one is not a route but a playthrough. */
export const MAX_ROUTE_STEPS = 24;
/** The most routes one run keeps; the oldest goes first. */
const MAX_KEPT_ROUTES = 4;
/** The most routes one evidence pass replays. */
const MAX_REPLAYS_PER_PASS = 3;
/** A route that parted ways this many times is retired. */
export const RETIRE_AFTER_DIVERGENCES = 3;
/** The most of the trace file read: a session's trace is a few dozen lines. */
const MAX_TRACE_ROWS = 400;
/** The most simulated time one replayed step runs. */
const MAX_STEP_MS = 30 * SECOND_MS;
/** The seed a stepped computer session plants when it is given none (computer-session.ts). */
const ROUTE_SEED = 1;
/** One wheel notch, as the computer tool turns it (computer-vocabulary.ts). */
const SCROLL_NOTCH_PX = 120;
/** The notches a scroll turns when it names none (computer-tool.ts). */
const DEFAULT_SCROLL_NOTCHES = 3;
/** The field of the run that holds its kept routes. */
const ROUTES_FIELD = "keptRoutes";

/** The computer tool's actions as its trace spells them: the home of these spellings in the seed. */
const ComputerAction = {
  LeftClick: "left_click",
  RightClick: "right_click",
  MiddleClick: "middle_click",
  DoubleClick: "double_click",
  TripleClick: "triple_click",
  LeftClickDrag: "left_click_drag",
  MouseMove: "mouse_move",
  LeftMouseDown: "left_mouse_down",
  LeftMouseUp: "left_mouse_up",
  Scroll: "scroll",
  Type: "type",
  Key: "key",
  HoldKey: "hold_key",
  Wait: "wait",
  Batch: "batch",
  Screenshot: "screenshot",
  Zoom: "zoom",
  CursorPosition: "cursor_position",
  Camera: "camera",
  State: "state",
  Console: "console",
  Reload: "reload",
} as const;

/** Actions that only look: a route drops them. */
const LOOKS: ReadonlySet<string> = new Set([
  ComputerAction.Screenshot,
  ComputerAction.Zoom,
  ComputerAction.CursorPosition,
  ComputerAction.Camera,
  ComputerAction.State,
  ComputerAction.Console,
]);

/** The clicks: which button, how many times. */
const CLICKS: Record<string, { button: "left" | "right" | "middle"; clicks: number }> = {
  [ComputerAction.LeftClick]: { button: "left", clicks: 1 },
  [ComputerAction.RightClick]: { button: "right", clicks: 1 },
  [ComputerAction.MiddleClick]: { button: "middle", clicks: 1 },
  [ComputerAction.DoubleClick]: { button: "left", clicks: 2 },
  [ComputerAction.TripleClick]: { button: "left", clicks: 3 },
};

/** The wheel's sign on each axis, per direction. */
const SCROLL_SIGN: Record<string, { x: number; y: number }> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

/** What a replay says, in the board's and the record's words. */
const MESSAGE = {
  diverged: (id: string, step: number, of: number, frames: string) =>
    `route ${id} diverged at step ${step} of ${of}: the goal did not hold after the same inputs${frames}`,
  framesOf: (original: string | null, replay: string | null) =>
    original || replay ? ` (frames: ${[original, replay].filter(Boolean).join(" vs ")})` : "",
  reportOnly: " — its session was not deterministic, so this is reported, never failed",
  held: (id: string) => `route ${id} replayed: the goal held after the same inputs`,
  retired: (id: string) => `route ${id} retired after ${RETIRE_AFTER_DIVERGENCES} divergences`,
} as const;

/** One action of a computer session, as `trace.jsonl` keeps it (substrate/computer-trace.ts). */
export interface TraceRow {
  i: number;
  action: string;
  args: AnyRecord;
  frame: string | null;
  cursor?: { x: number; y: number } | null;
  simMs: number | null;
  refused?: true;
  reached?: true;
}

/** One step of a route: the input to give (none for a wait) and the time to step after it. */
export interface RouteStep {
  input: PreviewInputAction | null;
  stepMs: number;
  /** The frame the original session saved at this step, by its name. */
  frame: string | null;
}

/** A route kept for this run: the goal it reached and the steps that reached it. */
export interface KeptRoute {
  id: string;
  quest: Quest;
  steps: RouteStep[];
  /** Every move of the original session ran on a stepped clock. */
  deterministic: boolean;
  divergences: number;
  retired: boolean;
}

/** One route's replay on a build. */
export interface RouteReplay {
  id: string;
  held: boolean;
  /** The step (from 1) after which the replay parted ways, or null when the goal held. */
  divergedAt: number | null;
  steps: number;
  deterministic: boolean;
  frames: { original: string | null; replay: string | null };
  retired: boolean;
}

/** What the routes' replays add to an evidence pass. */
export interface RouteReplays {
  replays: RouteReplay[];
  /** A diverged deterministic route, as a failed check naming its step. */
  results: CheckResult[];
  /** What a judge and a builder read: every divergence, and every report-only one. */
  notes: string[];
}

/** A trace line as a row, or null for anything that is not one. */
function traceRow(line: string): TraceRow | null {
  try {
    const row = JSON.parse(line);
    if (!isRecord(row) || typeof row.i !== "number" || typeof row.action !== "string") return null;
    return {
      i: row.i,
      action: row.action,
      args: isRecord(row.args) ? row.args : {},
      frame: typeof row.frame === "string" ? row.frame : null,
      cursor: isRecord(row.cursor) ? (row.cursor as TraceRow["cursor"]) : null,
      simMs: typeof row.simMs === "number" ? row.simMs : null,
      ...(row.refused === true ? { refused: true as const } : {}),
      ...(row.reached === true ? { reached: true as const } : {}),
    };
  } catch {
    return null;
  }
}

/** A session's trace file as rows; none when it cannot be read. */
export async function readTraceRows(file: string | null | undefined): Promise<TraceRow[]> {
  if (!file) return [];
  const text = await readFile(file, "utf8").catch(() => "");
  return text
    .split("\n")
    .slice(0, MAX_TRACE_ROWS)
    .map(traceRow)
    .filter((row): row is TraceRow => row !== null);
}

/** A point the trace kept, as a pair of numbers. */
function pointOf(value: unknown): { x: number; y: number } | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const [x, y] = value.map(Number);
  return Number.isFinite(x) && Number.isFinite(y) ? { x: x as number, y: y as number } : null;
}

/** A click at its point, or at the cursor the row says it was at; null when it is neither. */
function clickInput(args: AnyRecord, cursor: TraceRow["cursor"]): PreviewInputAction | null {
  const click = CLICKS[String(args.action)];
  const at = pointOf(args.coordinate) ?? cursor ?? null;
  // A click with held modifiers names them as text the seed cannot map to key codes: not replayable.
  if (!click || !at || args.text) return null;
  return { type: "click", x: at.x, y: at.y, button: click.button, clicks: click.clicks, px: true };
}

/** A scroll as the wheel's pixels. */
function scrollInput(args: AnyRecord): PreviewInputAction {
  const px = (Number(args.scroll_amount) || DEFAULT_SCROLL_NOTCHES) * SCROLL_NOTCH_PX;
  const sign = SCROLL_SIGN[String(args.scroll_direction)] ?? { x: 0, y: 0 };
  const at = pointOf(args.coordinate);
  return { type: "scroll", dx: sign.x * px, dy: sign.y * px, ...(at ? { x: at.x, y: at.y } : {}) };
}

/** A pointer move, drag or button: the preview's own action, or null when a point is missing. */
function pointerInput(args: AnyRecord): PreviewInputAction | null {
  const to = pointOf(args.coordinate);
  const from = pointOf(args.start_coordinate);
  if (args.action === ComputerAction.LeftClickDrag)
    return from && to
      ? { type: "drag", fromX: from.x, fromY: from.y, x: to.x, y: to.y, button: "left", px: true }
      : null;
  if (args.action === ComputerAction.MouseMove) return to ? { type: "move", x: to.x, y: to.y, px: true } : null;
  if (args.action === ComputerAction.LeftMouseDown) return { type: "mousedown", button: "left" };
  if (args.action === ComputerAction.LeftMouseUp) return { type: "mouseup", button: "left" };
  return null;
}

/** A keyboard action: typed text, a struck combo, a held key. */
function keyInput(args: AnyRecord): PreviewInputAction | null {
  const text = typeof args.text === "string" ? args.text : "";
  if (!text) return null;
  if (args.action === ComputerAction.Type) return { type: "type", text };
  if (args.action === ComputerAction.Key)
    return { type: "press", combo: text, repeat: Math.max(1, Number(args.repeat) || 1) };
  const ms = Math.round((Number(args.duration) || 1) * SECOND_MS);
  return { type: "hold", keys: text.split("+").filter(Boolean), ms };
}

/** One input request of a trace as the preview's action; null when it cannot be replayed. */
export function inputOf(args: AnyRecord, cursor: TraceRow["cursor"] = null): PreviewInputAction | null {
  const action = String(args.action);
  if (CLICKS[action]) return clickInput(args, cursor);
  if (action === ComputerAction.Scroll) return scrollInput(args);
  const keyed: string[] = [ComputerAction.Type, ComputerAction.Key, ComputerAction.HoldKey];
  if (keyed.includes(action)) return keyInput(args);
  return pointerInput(args);
}

/** The steps one row contributes; null when the row cannot be replayed (a reload, an unmappable input). */
function stepsOfRow(row: TraceRow): RouteStep[] | null {
  if (row.refused || LOOKS.has(row.action)) return [];
  if (row.action === ComputerAction.Reload) return null;
  const stepMs = Math.max(0, row.simMs ?? 0);
  if (row.action === ComputerAction.Wait) return [{ input: null, stepMs, frame: frameName(row.frame) }];
  const requests: unknown[] =
    row.action === ComputerAction.Batch && Array.isArray(row.args.steps) ? row.args.steps : [row.args];
  const steps: RouteStep[] = [];
  for (const request of requests) {
    const step = requestStep(isRecord(request) ? request : {}, row.cursor ?? null);
    if (!step) return null;
    steps.push(step);
  }
  // The whole row's simulated time runs after its last step: the trace keeps it per row.
  const last = steps.at(-1);
  if (last) Object.assign(last, { stepMs, frame: frameName(row.frame) });
  return steps;
}

/** One request of a row (a batch has several) as a step without time; null when it cannot be replayed. */
function requestStep(request: AnyRecord, cursor: TraceRow["cursor"]): RouteStep | null {
  if (request.action === ComputerAction.Wait) return { input: null, stepMs: 0, frame: null };
  const input = inputOf(request, cursor);
  return input ? { input, stepMs: 0, frame: null } : null;
}

/** A frame path as the name a judge cites it by. */
function frameName(frame: string | null): string | null {
  return frame ? path.basename(frame) : null;
}

/** The index of the action after which the studio verified the goal, from the rows. */
function reachedIndex(rows: readonly TraceRow[], reachedAt: number | null | undefined): number | null {
  const marked = rows.find((row) => row.reached)?.i;
  return marked ?? (typeof reachedAt === "number" ? reachedAt : null);
}

/**
 * A session that reached its goal, distilled to the inputs and waits that got there; null when it
 * never reached it, when a step cannot be replayed, or when the route would be longer than a route.
 */
export function distillRoute(
  rows: readonly TraceRow[],
  quest: Quest,
  { deterministic = false, reachedAt = null }: { deterministic?: boolean; reachedAt?: number | null } = {},
): KeptRoute | null {
  const until = reachedIndex(rows, reachedAt);
  if (until === null) return null;
  const steps: RouteStep[] = [];
  for (const row of rows) {
    if (row.i > until) break;
    const more = stepsOfRow(row);
    if (!more) return null;
    steps.push(...more);
  }
  if (steps.length === 0 || steps.length > MAX_ROUTE_STEPS) return null;
  return { id: quest.id, quest, steps, deterministic, divergences: 0, retired: false };
}

/** The routes this run keeps (on the run itself). */
export function keptRoutes(run: Run | AnyRecord | null | undefined): KeptRoute[] {
  const kept = run?.[ROUTES_FIELD];
  return Array.isArray(kept) ? (kept as KeptRoute[]) : [];
}

/**
 * Keep a route for the rest of this run: on the run (which every later evidence pass reads) and in
 * its journal when it has one. A route for the same goal replaces the one before it.
 */
export function keepRoute(holder: { run: Run | AnyRecord; journal?: AnyRecord | null }, route: KeptRoute): void {
  const routes = keptRoutes(holder.run).filter((kept) => kept.id !== route.id);
  routes.push(route);
  const kept = routes.slice(-MAX_KEPT_ROUTES);
  holder.run[ROUTES_FIELD] = kept;
  const director = holder.journal?.director;
  if (isRecord(director)) director.routes = kept;
}

/** A session's trace as its result carries it. */
interface TraceSummary {
  path: string | null;
  deterministic: boolean;
  reachedAt: number | null;
}

/**
 * Keep the route a judge's session played to its goal, when the studio verified the goal: read its
 * trace and distil it. Answers the route kept, or null when there is none to keep.
 */
export async function keepRouteOf(
  holder: { run: Run | AnyRecord; journal?: AnyRecord | null },
  trace: TraceSummary | null | undefined,
  quest: Quest,
): Promise<KeptRoute | null> {
  if (!trace?.path || trace.reachedAt === null) return null;
  const rows = await readTraceRows(trace.path);
  const route = distillRoute(rows, quest, { deterministic: trace.deterministic, reachedAt: trace.reachedAt });
  if (route) keepRoute(holder, route);
  return route;
}

/** Where and how a pass replays its run's routes. */
export interface ReplayOptions {
  run: Run;
  /** A leased window: a route is never replayed on the user's own view. */
  handle: string;
  labelPrefix: string;
}

/** Run one step on the page; false when the page refused its input. */
async function runStep(ctx: HarnessCtx, step: RouteStep, h: { handle: string }): Promise<boolean> {
  if (step.input) {
    const ok = await ctx
      .call(HostMethod.PreviewInput, { actions: [step.input], ...h })
      .then((answer) => answer?.ok !== false)
      .catch(() => false);
    if (!ok) return false;
  }
  if (step.stepMs > 0)
    await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Step, arg: Math.min(MAX_STEP_MS, step.stepMs), ...h });
  return true;
}

/** The frame a diverged replay ends on, for the record. */
async function replayFrame(ctx: HarnessCtx, run: Run, label: string, h: { handle: string }): Promise<string | null> {
  const shot = await ctx.call(HostMethod.PreviewScreenshot, { runId: run.runId, label, ...h }).catch(() => null);
  return shot?.path ?? null;
}

/** Replay one route on the loaded build: seed, the same inputs, then the goal. */
async function replayRoute(ctx: HarnessCtx, route: KeptRoute, options: ReplayOptions): Promise<RouteReplay> {
  const h = { handle: options.handle };
  await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Seed, arg: ROUTE_SEED, ...h });
  await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Pause, ...h }).catch(() => null);
  let refusedAt: number | null = null;
  for (const [index, step] of route.steps.entries()) {
    if (await runStep(ctx, step, h)) continue;
    refusedAt = index + 1;
    break;
  }
  const keep = { keep: [route.quest.until.path] };
  const state =
    refusedAt === null ? await ctx.call(HostMethod.PreviewState, { ...keep, ...h }).catch(() => null) : null;
  const held = questHolds(route.quest.until, state) === true;
  const divergedAt = held ? null : (refusedAt ?? route.steps.length);
  const original = divergedAt === null ? null : (route.steps[divergedAt - 1]?.frame ?? null);
  const replay =
    divergedAt === null ? null : await replayFrame(ctx, options.run, `${options.labelPrefix}/routes/${route.id}`, h);
  if (divergedAt !== null) route.divergences++;
  route.retired = route.divergences >= RETIRE_AFTER_DIVERGENCES;
  return {
    id: route.id,
    held,
    divergedAt,
    steps: route.steps.length,
    deterministic: route.deterministic,
    frames: { original, replay },
    retired: route.retired,
  };
}

/** A diverged deterministic route as a failed check that names its step. */
function divergedResult(replay: RouteReplay, sentence: string): CheckResult {
  return {
    id: `route-${replay.id}`,
    kind: CheckKind.Play,
    weight: CheckWeight.Normal,
    pass: false,
    reason: sentence,
    divergedAt: replay.divergedAt,
    frames: replay.frames,
  };
}

/** What one replay says, and what it adds to the pass. */
function weighReplay(replay: RouteReplay, out: RouteReplays): void {
  out.replays.push(replay);
  if (replay.divergedAt !== null) {
    const frames = MESSAGE.framesOf(replay.frames.original, replay.frames.replay);
    const sentence = MESSAGE.diverged(replay.id, replay.divergedAt, replay.steps, frames);
    if (replay.deterministic) out.results.push(divergedResult(replay, sentence));
    out.notes.push(replay.deterministic ? sentence : `${sentence}${MESSAGE.reportOnly}`);
  }
  if (replay.retired) out.notes.push(MESSAGE.retired(replay.id));
}

/** The record of one replay: studio-verified when the goal held; never a fail for a route that is report-only. */
function replayRecord(replay: RouteReplay, notes: string[]) {
  const status = replay.held ? InteractionStatus.Passed : InteractionStatus.Failed;
  return {
    head: null,
    label: `route ${replay.id}`,
    status: replay.deterministic || replay.held ? status : InteractionStatus.Incomplete,
    note: notes.find((note) => note.startsWith(`route ${replay.id} `)) ?? MESSAGE.held(replay.id),
    source: InteractionSource.RouteReplay,
    objective: replay.held ? InteractionObjective.StudioVerified : InteractionObjective.ModelSaid,
  };
}

/**
 * Replay this run's kept routes on the build the pass just looked at, on its leased window. Run
 * after every photograph is taken: a replay seeds the page and moves it.
 */
export async function replayRoutes(ctx: HarnessCtx, options: ReplayOptions): Promise<RouteReplays | null> {
  const routes = keptRoutes(options.run)
    .filter((route) => !route.retired)
    .slice(0, MAX_REPLAYS_PER_PASS);
  if (routes.length === 0) return null;
  const out: RouteReplays = { replays: [], results: [], notes: [] };
  for (const route of routes) {
    if (ctx.cancelled) break;
    const replay = await replayRoute(ctx, route, options).catch(() => null);
    if (!replay) continue;
    weighReplay(replay, out);
    await appendInteraction(ctx, options.run.runId, replayRecord(replay, out.notes));
  }
  return out;
}
