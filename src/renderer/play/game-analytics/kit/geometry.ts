/**
 * The pure sums behind the kit's DOM charts: a bucket's height against the tallest, a row's share
 * and its bar, a cell's shade, a funnel's flow from step to step, a week of hours cut into days, and
 * a report's annotations placed on the days of its period. The canvas charts' geometry (axes,
 * lines, stacked bars, marks) is in `stats-chart.ts`.
 */
import { type Annotation, AnnotationKind } from "../../../../shared/game-analytics.ts";
import { t } from "../../../../shared/i18n.ts";
import type { ChartMark } from "../../stats-chart.ts";

/** The faintest and the strongest a heat cell's tint gets, as a share of the heat colour. */
export const HEAT_MIN = 0.06;
export const HEAT_MAX = 0.62;
const WEEK_DAYS = 7;
const DAY_HOURS = 24;

const finite = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Each bucket's height as a share of the tallest (0 to 1); a missing or empty bucket is flat. */
export function bucketHeights(values: readonly (number | null)[]): number[] {
  const tallest = Math.max(0, ...values.filter(finite));
  return values.map((value) => (finite(value) && tallest > 0 ? Math.max(0, value) / tallest : 0));
}

/**
 * Each row's share of `total` (the rows' sum when left out; null with nothing to divide by) and its
 * bar's width against the longest row (0 to 1). Pass the first step's count as `total` for a funnel.
 */
export function barShares(values: readonly number[], total?: number): { share: number | null; width: number }[] {
  const whole = total ?? values.reduce((sum, value) => sum + value, 0);
  const longest = Math.max(0, ...values);
  return values.map((value) => ({
    share: whole > 0 ? value / whole : null,
    width: longest > 0 ? Math.max(0, value) / longest : 0,
  }));
}

/**
 * How strongly a heat cell is tinted, from `HEAT_MIN` for zero to `HEAT_MAX` for the busiest;
 * null for a missing value, whose cell stays bare.
 */
export function heatLevel(value: number | null | undefined, max: number): number | null {
  if (!finite(value)) return null;
  const share = max > 0 ? Math.min(1, Math.max(0, value) / max) : 0;
  // Three decimals: the level is written into the cell's style.
  return Math.round((HEAT_MIN + (HEAT_MAX - HEAT_MIN) * share) * 1000) / 1000;
}

/** What happens at one step of a funnel. */
export interface FunnelFlow {
  /** This step's people as a share of the first step's; null when the first is empty. */
  ofFirst: number | null;
  /** The share of this step's people who reach the next; null for the last step or an empty one. */
  onward: number | null;
  /** How many do not reach the next step, never negative; null for the last step. */
  lost: number | null;
}

/** The flow through a funnel's steps, given each step's count in order. */
export function funnelFlow(counts: readonly number[]): FunnelFlow[] {
  const first = counts[0] ?? 0;
  return counts.map((count, index) => {
    const next = counts[index + 1];
    return {
      ofFirst: first > 0 ? count / first : null,
      onward: next !== undefined && count > 0 ? next / count : null,
      lost: next === undefined ? null : Math.max(0, count - next),
    };
  });
}

/**
 * A week of hours (168 numbers from Monday 00:00, as the Engagement report sends them) as seven
 * rows of 24, Monday first; an hour the series does not reach is null.
 */
export function weekRows(hours: readonly (number | null)[]): (number | null)[][] {
  return Array.from({ length: WEEK_DAYS }, (_, day) =>
    Array.from({ length: DAY_HOURS }, (_, hour) => hours[day * DAY_HOURS + hour] ?? null),
  );
}

/**
 * Where a key moves a chart's readout from `current` (null when none is shown) among `count`
 * places: the arrows step and stop at the ends, Home and End jump to them. Null for a key that
 * does not move it, or a chart with no places.
 */
export function cursorTarget(key: string, current: number | null, count: number): number | null {
  if (count <= 0) return null;
  const last = count - 1;
  if (key === "Home") return 0;
  if (key === "End") return last;
  if (key === "ArrowRight") return current === null ? 0 : Math.min(last, current + 1);
  if (key === "ArrowLeft") return current === null ? last : Math.max(0, current - 1);
  return null;
}

/** A mark's label in full: what it is about, then the name the creator gave it. */
function markLabel(annotation: Annotation): string {
  return annotation.kind === AnnotationKind.Campaign
    ? t("Campaign {name}", { name: annotation.label })
    : t("Version {version}", { version: annotation.label });
}

/**
 * A report's annotations as marks for a per-day chart: `days` is the period's days (`periodDays`
 * of the answer's window), an annotation off the period is dropped, and the marks come in order.
 */
export function marksOf(annotations: readonly Annotation[], days: readonly string[]): ChartMark[] {
  return annotations
    .map((annotation) => ({ index: days.indexOf(annotation.on), kind: annotation.kind, label: markLabel(annotation) }))
    .filter((mark) => mark.index >= 0)
    .sort((a, b) => a.index - b.index);
}
