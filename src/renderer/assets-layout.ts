/**
 * Where every asset sits on the Assets canvas — pure, so the arrangement can be checked without
 * a window and never depends on the order the walk happened to return files in.
 *
 * Two rules decide the order, and both are about a person looking for something they just made:
 *
 *   1. Sources come in a fixed order — Genex first, then Blender, then any other plugin
 *      alphabetically, with the files you dropped in yourself last. A plugin installed during a run
 *      must not reshuffle yesterday's canvas.
 *   2. Inside a source, jobs are newest first, and the files of one job keep their own order by
 *      path. A generation that takes minutes therefore appears at the top and stays there.
 *
 * The rectangles are laid out in that order, five to a row, with fixed card sizes per kind, so
 * the same ledger always draws the same canvas.
 */
import { type AssetKind, type AssetSource, assetKind, type ProjectAsset } from "../shared/game-assets.ts";

/** The sources the studio names itself (`AssetSource`); any other source is a plugin id. */
const Source = {
  Genex: "genex",
  Blender: "blender",
  /** files nobody generated: dropped into the game folder by hand */
  Imported: "imported",
} as const satisfies Record<string, AssetSource>;

export interface AssetRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AssetGroupJob {
  id: string;
  /** The plugin's job id, or null for files nobody claimed. */
  jobId: string | null;
  /** When the job happened, if it said; jobs without one sort last. */
  at: string | null;
  /** The plugin's own word for what the job is doing. Shown as it is — it is not our vocabulary. */
  status?: string;
  prompt?: string;
  assets: ProjectAsset[];
  /** A job the studio has heard start and not heard finish: one placeholder card, no files yet. */
  pending?: boolean;
}

/**
 * A generation that is happening right now. It has no files on disk yet, so it cannot come from
 * the walk; the canvas carries it so a wait of several minutes is visible rather than an
 * unchanged screen.
 */
export interface PendingJob {
  source: string;
  jobId: string;
  at?: string;
  operation?: string;
  prompt?: string;
  /** The plugin's own word for the job. */
  pluginStatus?: string;
}

export interface AssetGroup {
  id: string;
  source: string;
  label: string;
  jobs: AssetGroupJob[];
  /** Every asset in the group, in the order the canvas draws them. */
  count: number;
}

export interface AssetsLayout {
  groups: AssetGroup[];
  /** Keyed by `group:<source>`, `job:<source>:<jobId|imported>` and `asset:<file>`. */
  rects: Record<string, AssetRect>;
  width: number;
  height: number;
}

/** Card sizes: a picture earns the room to be recognised, a metadata card does not. */
export const CARD_W = 184;
export const CARD_IMAGE_H = 168;
export const CARD_PLAIN_H = 112;
export const COLUMNS = 5;
const CARD_GAP = 14;
const GROUP_GAP = 36;
const GROUP_HEAD_H = 30;
const PAD = 32;

const KNOWN_FIRST: readonly string[] = [Source.Genex, Source.Blender];

/** What each named source is called on screen. */
const SOURCE_LABEL = new Map<string, string>([
  [Source.Genex, "Genex"],
  [Source.Blender, "Blender"],
  [Source.Imported, "Your files"],
]);

/** What a source is called on screen. A plugin id nobody ships is shown as it is. */
export function sourceLabel(source: string): string {
  return SOURCE_LABEL.get(source) ?? source;
}

function sourceRank(source: string): number {
  const known = KNOWN_FIRST.indexOf(source);
  if (known >= 0) return known;
  return source === Source.Imported ? KNOWN_FIRST.length + 1 : KNOWN_FIRST.length;
}

function compareSources(a: string, b: string): number {
  const rank = sourceRank(a) - sourceRank(b);
  return rank !== 0 ? rank : a.localeCompare(b);
}

/** Newest first; a job that never said when it happened goes after the ones that did. */
function compareJobs(a: AssetGroupJob, b: AssetGroupJob): number {
  if (a.at !== b.at) {
    if (!a.at) return 1;
    if (!b.at) return -1;
    return a.at < b.at ? 1 : -1;
  }
  return (a.jobId ?? "").localeCompare(b.jobId ?? "");
}

/**
 * Sort a project's assets into source → job → file. Files with no job id share one bucket per
 * source, which is what "the folder" means for hand-dropped files.
 */
export function groupAssets(assets: readonly ProjectAsset[], pending: readonly PendingJob[] = []): AssetGroup[] {
  const bySource = new Map<string, Map<string, AssetGroupJob>>();
  for (const asset of assets) addAsset(jobsOf(bySource, asset.source || Source.Imported), asset);
  for (const job of pending) addPending(jobsOf(bySource, job.source || Source.Imported), job);
  const groups: AssetGroup[] = [];
  for (const [source, jobs] of bySource) {
    const ordered = [...jobs.values()].sort(compareJobs);
    for (const job of ordered) job.assets.sort((a, b) => a.file.localeCompare(b.file));
    groups.push({
      id: `group:${source}`,
      source,
      label: sourceLabel(source),
      jobs: ordered,
      count: ordered.reduce((total, job) => total + job.assets.length, 0),
    });
  }
  return groups.sort((a, b) => compareSources(a.source, b.source));
}

/** A source's jobs by job id (files with none share the "" bucket), created on first use. */
function jobsOf(bySource: Map<string, Map<string, AssetGroupJob>>, source: string): SourceJobs {
  let jobs = bySource.get(source);
  if (!jobs) {
    jobs = new Map();
    bySource.set(source, jobs);
  }
  return { source, jobs };
}

type SourceJobs = { source: string; jobs: Map<string, AssetGroupJob> };

/** Whether a file's time comes before its job's; a job with no time yet takes any. */
const isEarlier = (at: string, jobAt: string | null): boolean => !jobAt || at < jobAt;

function addAsset({ source, jobs }: SourceJobs, asset: ProjectAsset): void {
  const jobId = asset.jobId ?? null;
  const key = jobId ?? "";
  let job = jobs.get(key);
  if (!job) {
    job = { id: `job:${source}:${jobId ?? Source.Imported}`, jobId, at: asset.at ?? null, assets: [] };
    jobs.set(key, job);
  }
  // One job, one moment: the earliest timestamp any of its files carries.
  if (asset.at && isEarlier(asset.at, job.at)) job.at = asset.at;
  if (!job.status && asset.pluginStatus) job.status = asset.pluginStatus;
  if (!job.prompt && asset.prompt) job.prompt = asset.prompt;
  job.assets.push(asset);
}

function addPending({ source, jobs }: SourceJobs, job: PendingJob): void {
  // A delivery that has already landed wins: the real files replace the placeholder.
  if (jobs.has(job.jobId)) return;
  jobs.set(job.jobId, {
    id: `job:${source}:${job.jobId}`,
    jobId: job.jobId,
    at: job.at ?? null,
    assets: [],
    pending: true,
    ...(job.pluginStatus ? { status: job.pluginStatus } : {}),
    ...(job.prompt ? { prompt: job.prompt } : {}),
  });
}

/** How tall a card of this kind is. Media and models have room for recognizable previews. */
export function cardHeight(kind: AssetKind): number {
  return kind === "other" ? CARD_PLAIN_H : CARD_IMAGE_H;
}

/**
 * Deterministic rectangles: source groups contain a continuous grid in job order.
 * A completed job needs no metadata row or empty band between its previews.
 */
export function layoutAssets(assets: readonly ProjectAsset[], pending: readonly PendingJob[] = []): AssetsLayout {
  const groups = groupAssets(assets, pending);
  const rects: Record<string, AssetRect> = {};
  const widths: number[] = [];
  let y = PAD;
  for (const group of groups) {
    const rect = placeGroup(rects, group, y);
    widths.push(rect.w);
    y = rect.y + rect.h + GROUP_GAP;
  }
  if (groups.length) y -= GROUP_GAP;
  return { groups, rects, width: Math.max(0, ...widths) + PAD * 2, height: y + PAD };
}

/** Where the next card of a group's grid goes. */
interface GridCursor {
  column: number;
  rowTop: number;
  rowHeight: number;
}

/** One group: its header, then its jobs' cards in one continuous grid. Returns the group's rect. */
function placeGroup(rects: Record<string, AssetRect>, group: AssetGroup, top: number): AssetRect {
  const grid: GridCursor = { column: 0, rowTop: top + GROUP_HEAD_H, rowHeight: 0 };
  for (const job of group.jobs) {
    const jobRects = jobCards(group, job).map((card) => placeCard(rects, grid, card));
    const [first] = jobRects;
    if (!first) continue;
    const left = Math.min(...jobRects.map((r) => r.x));
    rects[job.id] = {
      x: left,
      y: first.y,
      w: Math.max(...jobRects.map((r) => r.x + r.w)) - left,
      h: grid.rowTop + grid.rowHeight - first.y,
    };
  }
  const bottom = grid.rowTop + grid.rowHeight;
  const usedColumns = Math.min(COLUMNS, group.count + group.jobs.filter((job) => job.pending).length);
  const rect = {
    x: PAD,
    y: top,
    w: usedColumns * CARD_W + Math.max(0, usedColumns - 1) * CARD_GAP,
    h: bottom - top,
  };
  rects[group.id] = rect;
  return rect;
}

/** A pending job is one placeholder card; a delivered one is a card per file. */
function jobCards(group: AssetGroup, job: AssetGroupJob): Array<{ id: string; height: number }> {
  if (job.pending) return [{ id: `pending:${group.source}:${job.jobId ?? ""}`, height: CARD_IMAGE_H }];
  return job.assets.map((asset) => ({
    id: `asset:${asset.file}`,
    height: cardHeight(asset.kind ?? assetKind(asset.file)),
  }));
}

/** The next cell of the grid, wrapping to a new row after `COLUMNS` cards. */
function placeCard(
  rects: Record<string, AssetRect>,
  grid: GridCursor,
  card: { id: string; height: number },
): AssetRect {
  if (grid.column === COLUMNS) {
    grid.column = 0;
    grid.rowTop += grid.rowHeight + CARD_GAP;
    grid.rowHeight = 0;
  }
  const rect = { x: PAD + grid.column * (CARD_W + CARD_GAP), y: grid.rowTop, w: CARD_W, h: card.height };
  rects[card.id] = rect;
  grid.rowHeight = Math.max(grid.rowHeight, card.height);
  grid.column++;
  return rect;
}
