/**
 * Routes: a judge's session that reached its goal on a stepped clock, kept as the computer calls
 * that got there and replayed on every later build of the run. A build that no longer lets the
 * same calls reach the same goal has regressed somewhere a screenshot cannot see, and the replay
 * names the step where it parted ways.
 *
 * - `distillRoute` (pure): the trace's calls up to the move after which the studio verified the
 *   goal, each with the arguments it ran with; looks are dropped. A batch stays one call, so its
 *   steps keep the timing they had.
 * - `keepRoute`: kept for this run only, on the run and in its journal.
 * - `replayRoutes`: from the evidence pass, on a leased window, THROUGH the host's own computer
 *   session (`preview.computer`): a fresh one (reloaded, reseeded, its own trace), blind, on a
 *   stepped clock, given the kept goal, one kept call at a time. The host derives the inputs and
 *   steps the clock exactly as it did for the judge, and checks the goal after every move. A route
 *   whose original or replayed session was not deterministic never fails a check: it is reported.
 *   On a host without the computer session a route is not replayed, and that is reported.
 *
 * A new module: evidence.ts calls it through a namespace import, so a kept older evidence.ts never
 * needs it and this one never stops it loading.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PlayPacing, PlayRole, type ComputerGrant } from "./computer-loop.ts";
import { HostMethod } from "./host-methods.ts";
import {
  appendInteraction,
  InteractionObjective,
  InteractionSource,
  InteractionStatus,
} from "./interaction-evidence.ts";
import { isRecord } from "./json.ts";
import { type Quest, questGrant } from "./quest.ts";
import { CheckKind, CheckWeight } from "./spec.ts";
import type { AnyRecord, HarnessCtx, Run } from "../types/harness.d.ts";
import type { ComputerTraceSummary } from "../types/host-api.d.ts";
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
/** The most steps one batch call may carry (the computer tool's own cap). */
const MAX_BATCH_STEPS = 8;
/** The moves a replay may make: every kept call a full batch, so the budget never cuts a route short. */
const REPLAY_MAX_ACTIONS = MAX_ROUTE_STEPS * MAX_BATCH_STEPS;
/** The facet a replay's frames and trace are filed under. */
const ROUTES_FACET = "routes";
/** The field of the run that holds its kept routes. */
const ROUTES_FIELD = "keptRoutes";

/** The computer tool's actions a route reads, as its trace spells them: the home of these spellings in the seed. */
const ComputerAction = {
  Batch: "batch",
  Screenshot: "screenshot",
  Zoom: "zoom",
  CursorPosition: "cursor_position",
  State: "state",
  Console: "console",
} as const;

/** Actions that only look: a route drops them. */
const LOOKS: ReadonlySet<string> = new Set([
  ComputerAction.Screenshot,
  ComputerAction.Zoom,
  ComputerAction.CursorPosition,
  ComputerAction.State,
  ComputerAction.Console,
]);

/** What a replay says, in the board's and the record's words. */
const MESSAGE = {
  diverged: (id: string, step: number, of: number, frames: string, trace: string | null) =>
    `route ${id} diverged at step ${step} of ${of}: the goal did not hold after the same calls${frames}${trace ? ` (replay trace: ${trace})` : ""}`,
  framesOf: (original: string | null, replay: string | null) =>
    original || replay ? ` (frames: ${[original, replay].filter(Boolean).join(" vs ")})` : "",
  reportOnly: " — its session was not deterministic, so this is reported, never failed",
  held: (id: string) => `route ${id} replayed: the goal held after the same calls`,
  retired: (id: string) => `route ${id} retired after ${RETIRE_AFTER_DIVERGENCES} divergences`,
  notReplayed: (id: string, why: string) => `route ${id} not replayed: ${why} — reported, never failed`,
  noComputer: "this studio has no computer session to replay it through",
  noRoot: "the pass names no build folder to replay it in",
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

/** One step of a route: one computer call, with the arguments it ran with. */
export interface RouteStep {
  args: AnyRecord;
  /** The frame the original session saved at this step, by its name. */
  frame: string | null;
}

/** A route kept for this run: the goal it reached and the calls that reached it. */
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
  /** The original and the replayed session both ran on a stepped clock. */
  deterministic: boolean;
  frames: { original: string | null; replay: string | null };
  /** The replay's own trace, which the host vouches for when it saw the goal reached. */
  trace: string | null;
  retired: boolean;
}

/** What the routes' replays add to an evidence pass. */
export interface RouteReplays {
  replays: RouteReplay[];
  /** A diverged deterministic route, as a failed check naming its step. */
  results: CheckResult[];
  /** What a judge and a builder read: every divergence, every report-only one, every route not replayed. */
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

/**
 * A row's arguments as the call that ran them. The trace keeps a batch's parsed steps as `steps`;
 * the tool takes them as `actions`. Everything else is passed as it ran: the host parses it again.
 */
function callArgs(args: AnyRecord): AnyRecord {
  if (args.action !== ComputerAction.Batch || !Array.isArray(args.steps)) return { ...args };
  const { steps, ...rest } = args;
  return { ...rest, actions: steps };
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

/** Does a row move the game: not refused, and not a look. */
function moves(row: TraceRow): boolean {
  return !row.refused && !LOOKS.has(row.action);
}

/**
 * A session that reached its goal, distilled to the calls that got there; null when it never
 * reached it or when the route would be longer than a route.
 */
export function distillRoute(
  rows: readonly TraceRow[],
  quest: Quest,
  { deterministic = false, reachedAt = null }: { deterministic?: boolean; reachedAt?: number | null } = {},
): KeptRoute | null {
  const until = reachedIndex(rows, reachedAt);
  if (until === null) return null;
  const steps = rows
    .filter((row) => row.i <= until && moves(row))
    .map((row) => ({ args: callArgs(row.args), frame: frameName(row.frame) }));
  if (steps.length === 0 || steps.length > MAX_ROUTE_STEPS) return null;
  return { id: quest.id, quest, steps, deterministic, divergences: 0, retired: false };
}

/** A route kept as computer calls: one an older seed kept as preview inputs is not replayable here. */
function isCallRoute(route: unknown): route is KeptRoute {
  if (!isRecord(route) || !isRecord(route.quest) || !Array.isArray(route.steps)) return false;
  return route.steps.length > 0 && route.steps.every((step) => isRecord(step) && isRecord(step.args));
}

/** The routes this run keeps (on the run itself). */
export function keptRoutes(run: Run | AnyRecord | null | undefined): KeptRoute[] {
  const kept = run?.[ROUTES_FIELD];
  return Array.isArray(kept) ? kept.filter(isCallRoute) : [];
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
  /** The build's folder, as the pass loaded it; without one there is no build to replay in. */
  root: string | null | undefined;
  /** A leased window: a route is never replayed on the user's own view. */
  handle: string;
  labelPrefix: string;
  entry?: string;
  iteration?: number;
}

/** Does this studio's harness know the computer session at all (a kept older host-methods.ts may not). */
function knowsComputer(): boolean {
  return Object.hasOwn(HostMethod, "PreviewComputer");
}

/** The session a route is replayed in: blind, stepped, from the game's first screen, given the kept goal. */
function replayGrant(route: KeptRoute, options: ReplayOptions & { root: string }): ComputerGrant {
  const { run, root, handle, entry, iteration } = options;
  return {
    project: run.project,
    root,
    handle,
    runId: run.runId,
    facetId: ROUTES_FACET,
    iteration: iteration ?? 0,
    ...(entry ? { entry } : {}),
    setup: { begin: false },
    label: `route ${route.id}`,
    role: PlayRole.Judge,
    pacing: PlayPacing.Stepped,
    quest: questGrant(route.quest),
    maxActions: REPLAY_MAX_ACTIONS,
  };
}

/** Each kept call through the host's session, one at a time, until the host saw the goal; the trace it left. */
async function replayCalls(
  ctx: HarnessCtx,
  route: KeptRoute,
  grant: ComputerGrant,
): Promise<ComputerTraceSummary | null> {
  let trace: ComputerTraceSummary | null = null;
  for (const [index, step] of route.steps.entries()) {
    const fresh = index === 0 ? { fresh: true } : {};
    const answered = await ctx.call(HostMethod.PreviewComputer, { ...grant, ...fresh, args: step.args });
    if (answered && "trace" in answered) trace = answered.trace;
    if (typeof trace?.reachedAt === "number") break;
  }
  return trace;
}

/** Where the replay parted ways: the first call the session refused, else the route's last step. */
function divergedStep(rows: readonly TraceRow[], steps: number): number {
  const refused = rows.find((row) => row.refused)?.i;
  return typeof refused === "number" ? Math.min(refused, steps) : steps;
}

/** Replay one route on the build through a fresh host session, and weigh where it ended. */
async function replayRoute(
  ctx: HarnessCtx,
  route: KeptRoute,
  options: ReplayOptions & { root: string },
): Promise<RouteReplay> {
  const trace = await replayCalls(ctx, route, replayGrant(route, options));
  const held = typeof trace?.reachedAt === "number";
  const rows = held ? [] : await readTraceRows(trace?.path);
  const divergedAt = held ? null : divergedStep(rows, route.steps.length);
  const original = divergedAt === null ? null : (route.steps[divergedAt - 1]?.frame ?? null);
  const replayFrame = divergedAt === null ? null : (rows.find((row) => row.i === divergedAt)?.frame ?? null);
  if (divergedAt !== null) route.divergences++;
  route.retired = route.divergences >= RETIRE_AFTER_DIVERGENCES;
  return {
    id: route.id,
    held,
    divergedAt,
    steps: route.steps.length,
    deterministic: route.deterministic && trace?.deterministic === true,
    frames: { original, replay: replayFrame },
    trace: trace?.path ?? null,
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
    trace: replay.trace,
  };
}

/** What one replay says, and what it adds to the pass. */
function weighReplay(replay: RouteReplay, out: RouteReplays): void {
  out.replays.push(replay);
  if (replay.divergedAt !== null) {
    const frames = MESSAGE.framesOf(replay.frames.original, replay.frames.replay);
    const sentence = MESSAGE.diverged(replay.id, replay.divergedAt, replay.steps, frames, replay.trace);
    if (replay.deterministic) out.results.push(divergedResult(replay, sentence));
    out.notes.push(replay.deterministic ? sentence : `${sentence}${MESSAGE.reportOnly}`);
  }
  if (replay.retired) out.notes.push(MESSAGE.retired(replay.id));
}

/** The status a replay is recorded with: a fail only for a deterministic route that parted ways. */
function replayStatus(replay: RouteReplay): InteractionStatus {
  if (replay.held) return InteractionStatus.Passed;
  return replay.deterministic ? InteractionStatus.Failed : InteractionStatus.Incomplete;
}

/**
 * The record of one replay, with the replay's trace: studio-verified only when the host saw the
 * goal reached (the host keeps that word only for a trace it saw reach it).
 */
function replayRecord(replay: RouteReplay, notes: string[]) {
  return {
    head: null,
    label: `route ${replay.id}`,
    status: replayStatus(replay),
    note: notes.find((note) => note.startsWith(`route ${replay.id} `)) ?? MESSAGE.held(replay.id),
    source: InteractionSource.RouteReplay,
    objective: replay.held ? InteractionObjective.StudioVerified : InteractionObjective.ModelSaid,
    trace: replay.trace,
  };
}

/** Every route reported as not replayed, and why: never a fail, never a divergence. */
function notReplayed(routes: readonly KeptRoute[], why: string): RouteReplays {
  return { replays: [], results: [], notes: routes.map((route) => MESSAGE.notReplayed(route.id, why)) };
}

/**
 * Replay this run's kept routes on the build the pass just looked at, on its leased window. Run
 * after every photograph is taken: a replay reloads the page and moves it.
 */
export async function replayRoutes(ctx: HarnessCtx, options: ReplayOptions): Promise<RouteReplays | null> {
  const routes = keptRoutes(options.run)
    .filter((route) => !route.retired)
    .slice(0, MAX_REPLAYS_PER_PASS);
  if (routes.length === 0) return null;
  if (!knowsComputer()) return notReplayed(routes, MESSAGE.noComputer);
  const { root } = options;
  if (!root) return notReplayed(routes, MESSAGE.noRoot);
  const out: RouteReplays = { replays: [], results: [], notes: [] };
  for (const route of routes) {
    if (ctx.cancelled) break;
    const replay = await tryReplay(ctx, route, { ...options, root });
    if ("failed" in replay) {
      out.notes.push(MESSAGE.notReplayed(route.id, replay.failed));
      continue;
    }
    weighReplay(replay, out);
    await appendInteraction(ctx, options.run.runId, replayRecord(replay, out.notes));
  }
  return out;
}

/**
 * One replay, or why it could not run: a host that refuses the session (an older one without it,
 * a window that went away) measured nothing about the build.
 */
async function tryReplay(
  ctx: HarnessCtx,
  route: KeptRoute,
  options: ReplayOptions & { root: string },
): Promise<RouteReplay | { failed: string }> {
  try {
    return await replayRoute(ctx, route, options);
  } catch (err) {
    return { failed: err instanceof Error ? err.message : String(err) };
  }
}
