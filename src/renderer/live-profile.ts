/**
 * Pure derivations for Live's profile strip (game-systems PROF-7): the frame-time sparkline with
 * its hitch markers and budget line, the heaviest scopes, memory against its budgets, the armed
 * GPU nodes, and the crash card's lines. Every input is a parsed answer (`shared/frame-profile.ts`,
 * `shared/crash-record.ts`); nothing here reads the clock or the store.
 */
import type { GameCrashEntry } from "../shared/crash-record.ts";
import type { ProfileReportV2, ProfileSummaryV1 } from "../shared/frame-profile.ts";

/** How many polls the sparkline keeps (30 s at the strip's 500 ms poll). */
export const PROFILE_HISTORY_POINTS = 60;
/** The frame budget the sparkline draws a line at: one 60 Hz frame. */
export const PROFILE_BUDGET_MS = 1000 / 60;
/** The crash card's most symbolicated frames. */
export const CRASH_CARD_FRAMES = 3;
const MIB = 1024 * 1024;

/** One poll of the summary: its CPU and GPU p95 and how many hitches the game had counted. */
export interface ProfilePoint {
  cpuMs: number;
  gpuMs: number | null;
  hitches: number;
}

/** The point a summary adds to the sparkline. */
export function profilePointOf(summary: ProfileSummaryV1): ProfilePoint {
  return { cpuMs: summary.cpu.p95, gpuMs: summary.gpu?.p95 ?? null, hitches: summary.hitches.count };
}

/** `history` with `point` added, the oldest dropped past {@link PROFILE_HISTORY_POINTS}. */
export function withPoint(history: readonly ProfilePoint[], point: ProfilePoint): ProfilePoint[] {
  return [...history, point].slice(-PROFILE_HISTORY_POINTS);
}

/** The sparkline in a `width` × `height` box: polyline points, hitch markers and the budget line's y. */
export interface Sparkline {
  cpu: string;
  gpu: string;
  /** One marker per poll whose hitch count rose since the poll before it. */
  hitches: number[];
  budgetY: number;
  /** The milliseconds the box's top stands for. */
  ceilingMs: number;
}

/** The x of poll `index`: the newest poll at the right edge, older ones a step to the left each. */
function xOf(index: number, count: number, width: number): number {
  const step = width / (PROFILE_HISTORY_POINTS - 1);
  return width - (count - 1 - index) * step;
}

const round = (value: number): number => Math.round(value * 10) / 10;

/**
 * The sparkline of `history`: the box's top is the larger of twice the budget and the slowest
 * poll, so the budget line stays in view and a spike never leaves the box.
 */
export function sparklineOf(history: readonly ProfilePoint[], width: number, height: number): Sparkline {
  const slowest = Math.max(0, ...history.map((point) => Math.max(point.cpuMs, point.gpuMs ?? 0)));
  const ceilingMs = Math.max(PROFILE_BUDGET_MS * 2, slowest);
  const yOf = (ms: number): number => round(height - (ms / ceilingMs) * height);
  const line = (pick: (point: ProfilePoint) => number | null): string =>
    history
      .flatMap((point, index) => {
        const ms = pick(point);
        return ms === null ? [] : [`${round(xOf(index, history.length, width))},${yOf(ms)}`];
      })
      .join(" ");
  const hitches = history.flatMap((point, index) => {
    const before = history[index - 1];
    return before && point.hitches > before.hitches ? [round(xOf(index, history.length, width))] : [];
  });
  return {
    cpu: line((point) => point.cpuMs),
    gpu: line((point) => point.gpuMs),
    hitches,
    budgetY: yOf(PROFILE_BUDGET_MS),
    ceilingMs,
  };
}

/** One of the heaviest scopes: its name, whether the game named it, and its p95 in ms. */
export interface ScopeRow {
  scope: string;
  game: boolean;
  ms: number;
}

/** The summary's heaviest scopes, heaviest first; a game's own scopes are flagged. */
export function topScopeRows(summary: ProfileSummaryV1): ScopeRow[] {
  return summary.top.map((row) => ({ scope: row.scope, game: row.game, ms: row.p95 })).sort((a, b) => b.ms - a.ms);
}

/** One memory row against its budget: MiB, the share of the budget used, and whether it is over. */
export interface MemoryRow {
  name: string;
  mib: number;
  budgetMib: number | null;
  /** Used over budget, 0..1 for the bar (capped); null without a budget. */
  fraction: number | null;
  over: boolean;
}

/** The summary's memory rows, those over their budget first. */
export function memoryRows(summary: ProfileSummaryV1): MemoryRow[] {
  const rows = summary.memory.map((row): MemoryRow => {
    const budgeted = row.budget !== undefined && row.budget > 0;
    const budget = budgeted ? (row.budget ?? 0) : 0;
    return {
      name: row.class,
      mib: round(row.bytes / MIB),
      budgetMib: budgeted ? round(budget / MIB) : null,
      fraction: budgeted ? Math.min(1, row.bytes / budget) : null,
      over: budgeted && row.bytes > budget,
    };
  });
  return rows.sort((a, b) => Number(b.over) - Number(a.over));
}

/** One armed GPU node: its frame-graph name and its mean time over the report's frames. */
export interface GpuNodeRow {
  node: string;
  ms: number;
}

/** The report's per-node GPU time, mean per frame that timed it, slowest first. */
export function gpuNodeRows(report: ProfileReportV2): GpuNodeRow[] {
  const totals = new Map<string, { ms: number; frames: number }>();
  for (const frame of report.frames)
    for (const { node, ms } of frame.gpu) {
      const seen = totals.get(node) ?? { ms: 0, frames: 0 };
      totals.set(node, { ms: seen.ms + ms, frames: seen.frames + 1 });
    }
  return [...totals.entries()]
    .map(([node, total]) => ({ node, ms: Math.round((total.ms / total.frames) * 100) / 100 }))
    .sort((a, b) => b.ms - a.ms);
}

/** The crash card: what happened, where, the first named frames, and the tick and seed to replay it. */
export interface CrashCardView {
  kind: string;
  message: string;
  /** `file:line` of the panic site, when the record has one. */
  location: string | null;
  /** The first named frames (`function (file:line)`), foreign frames left out. */
  frames: string[];
  tick: number | null;
  seed: number | null;
  repeat: number;
}

/** One symbolicated frame's innermost named function, as the card says it; null when it names none. */
function frameLine(entry: GameCrashEntry, index: number): string | null {
  const frame = entry.symbols?.frames[index];
  if (!frame || frame.foreign) return null;
  const named = frame.functions.find((fn) => fn.function !== null);
  if (!named?.function) return null;
  const place = named.file && named.line !== null ? ` (${named.file}:${named.line})` : "";
  return `${named.function}${place}`;
}

/** The card for a kept crash record. */
export function crashCardOf(entry: GameCrashEntry): CrashCardView {
  const { record } = entry;
  // A recursion names one function many times: the card lists each once.
  const named = record.frames.map((_, index) => frameLine(entry, index)).filter((line) => line !== null);
  const frames = [...new Set(named)].slice(0, CRASH_CARD_FRAMES);
  return {
    kind: record.kind,
    message: record.message,
    location: record.location ? `${record.location.file}:${record.location.line}` : null,
    frames,
    tick: record.context.tick ?? null,
    seed: record.context.seed ?? null,
    repeat: entry.repeat,
  };
}
