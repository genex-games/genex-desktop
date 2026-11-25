/**
 * No-input baselines from the instrument's page-side frame series (a 64x36 mirror diffed per sample).
 * Two baselines, and each check names the one it used: the pre-gesture idle (on a game with a title
 * screen that is the MENU's drift) and the post-entrance window, taken on gameplay once the entrance
 * is confirmed, which is where every gated input measurement happens.
 */
import type { ProbeSample } from "../instrument.ts";
import { mean, percentile } from "../frames.ts";
import { readProbeSeriesInPage } from "../driver.ts";
import type { PhaseContext } from "./context.ts";

/** A response is a change when it exceeds this multiple of the baseline's p95. */
export const CHANGE_OVER_IDLE = 3;
/**
 * Absolute floor, so a page with too little drift to measure does not get a zero threshold. It
 * stands in for drift the no-input window was too short to see: 0.4% of the frame, about nine
 * cells of the instrument's mirror changing completely.
 */
export const MIN_CHANGE_DIFF = 0.004;
/** The cells of the instrument's frame mirror (64x36); a test holds this to the instrument's own. */
export const MIRROR_CELLS = 64 * 36;
/**
 * The floor against a baseline that never changed at all: a quarter of one mirror cell changing
 * completely. A page that showed no change in any reading has no drift to stand above, only
 * rounding (a few channel steps measure about 2e-6). `MIN_CHANGE_DIFF` asked such a page for nine
 * cells' worth of change, which one small moving thing never gives: a 16 px golf ball rolling on an
 * 800x600 board covers about one cell and measured 0.0008, so the known-good mini golf failed both
 * input rows while its stroke counter ran to 38.
 */
export const STILL_CHANGE_DIFF = 1 / MIRROR_CELLS / 4;
/** The fewest readings, every one exactly zero, that show a page is still without input: a second's worth. */
export const MIN_STILL_SAMPLES = 30;
/** The fewest sampler readings a baseline may set a threshold from. */
export const MIN_BASELINE_SAMPLES = 5;

/** Which no-input window a threshold came from. */
export const BaselineName = {
  PreGesture: "pre-gesture",
  PostEntrance: "post-entrance",
} as const;
export type BaselineName = (typeof BaselineName)[keyof typeof BaselineName];

/** One no-input baseline and the change threshold derived from it. */
export interface PageBaseline {
  name: BaselineName;
  samples: number;
  pageMeanDiff: number;
  pageP95Diff: number;
  pageMaxDiff: number;
  /** `max(p95 × CHANGE_OVER_IDLE, changeFloor)`: what an input response must clear. */
  changeThreshold: number;
  /** Enough samples to stand on; a thin baseline is recorded, never applied. */
  usable: boolean;
}

/** Whether the baseline showed a page that does not change at all without input. */
export function isStillBaseline(baseline: Pick<PageBaseline, "samples" | "pageMaxDiff">): boolean {
  return baseline.samples >= MIN_STILL_SAMPLES && baseline.pageMaxDiff === 0;
}

/** The absolute floor a change must clear whatever the baseline's drift: fine on a still page, coarse otherwise. */
export function changeFloor(baseline: Pick<PageBaseline, "samples" | "pageMaxDiff">): number {
  return isStillBaseline(baseline) ? STILL_CHANGE_DIFF : MIN_CHANGE_DIFF;
}

/** A baseline from the diffs read in a no-input window. */
export function buildBaseline(name: BaselineName, diffs: readonly number[]): PageBaseline {
  const p95 = percentile(diffs, 0.95);
  const pageMaxDiff = diffs.length ? Math.max(...diffs) : 0;
  return {
    name,
    samples: diffs.length,
    pageMeanDiff: mean(diffs),
    pageP95Diff: p95,
    pageMaxDiff,
    changeThreshold: Math.max(p95 * CHANGE_OVER_IDLE, changeFloor({ samples: diffs.length, pageMaxDiff })),
    usable: diffs.length >= MIN_BASELINE_SAMPLES,
  };
}

/** The post-entrance baseline when it is usable, else the pre-gesture one. */
export function appliedBaseline(pre: PageBaseline, post: PageBaseline | null): PageBaseline {
  return post?.usable ? post : pre;
}

/** Where the next series read starts. */
export interface SeriesCursor {
  next: number;
}

/** Read the samples the instrument took since the cursor, advancing it. */
export async function pullSeries(ctx: PhaseContext, cursor: SeriesCursor): Promise<ProbeSample[]> {
  const series = await ctx.page.evaluate(readProbeSeriesInPage, cursor.next);
  if (!series) return [];
  cursor.next = series.nextFrame;
  return series.frames;
}

/** Sleep for `ms` with no input and return the diffs sampled in that window. */
export async function quietWindow(ctx: PhaseContext, cursor: SeriesCursor, ms: number): Promise<number[]> {
  await pullSeries(ctx, cursor);
  await ctx.sleep(ms);
  return (await pullSeries(ctx, cursor)).map((s) => s.d);
}
