/** What the Builds tab reads off an asset job: its first picture, its kind in words, and whether it is still being made. */
import { isUnderWay, MakingPhase } from "../../../shared/asset-making.ts";
import { type AssetKind, assetFormat, assetKind } from "../../../shared/game-assets.ts";
import { intlLocale, t } from "../../../shared/i18n.ts";
import { stoppedTitle } from "../../asset-making.ts";
import type { AssetInfo } from "../../run-graph.ts";
import { AssetCardState, BLENDER_SOURCE } from "../../run-graph-assets.ts";
import { Tone } from "../../run-steps.ts";
import { ASSET_JOB_WORDS } from "../../words.ts";

/** The largest side, in pixels, of a job's thumbnail still. */
export const ASSET_THUMB_PX = 128;

const KIND_WORD: Partial<Record<AssetKind, string>> = {
  model: t("3D model"),
  audio: t("Sound"),
  image: t("Image"),
  video: t("Video"),
};

/** A job's kind as a word, from its first file, or null when it names no kind the panel knows. */
export const kindWord = (job: AssetInfo): string | null =>
  job.files[0] ? (KIND_WORD[assetKind(job.files[0])] ?? null) : null;

/** The first picture a job delivered that the contained reader can show as a thumbnail. */
export const firstImage = (job: AssetInfo): string | null =>
  job.files.find((file) => assetFormat(file)?.raster) ?? null;

const isOpen = (job: AssetInfo): boolean =>
  job.state === AssetCardState.Requested || job.state === AssetCardState.Generating;

/**
 * Where a job the log leaves on its way stopped short, as the game's inventory says (Not confirmed,
 * Didn’t finish…), or null while it is on its way or the inventory says nothing of it.
 */
export function stoppedShort(job: AssetInfo): MakingPhase | null {
  if (!isOpen(job) || !job.waiting || isUnderWay(job.waiting)) return null;
  return job.waiting;
}

/** Whether a job is still on its way: asked for, or being generated, and not stopped short. */
export const isMaking = (job: AssetInfo): boolean => isOpen(job) && stoppedShort(job) === null;

/** The ways a job stops short, in the order the panel lists them. */
export const STOPPED_PHASES = [
  MakingPhase.Failed,
  MakingPhase.Stopped,
  MakingPhase.Unsure,
  MakingPhase.NotFetched,
  MakingPhase.NotInGame,
] as const;

/** A way a job stops short. */
type StoppedPhase = (typeof STOPPED_PHASES)[number];

/** How many jobs stopped short in one way, as the run's assets line counts them: "2 didn’t finish". */
const STOPPED_COUNT: Record<StoppedPhase, (count: number) => string> = {
  [MakingPhase.Failed]: (count) => t("{count, plural, other {# didn’t finish}}", { count }),
  [MakingPhase.Stopped]: (count) => t("{count, plural, other {# stopped}}", { count }),
  [MakingPhase.Unsure]: (count) => t("{count, plural, other {# not confirmed}}", { count }),
  [MakingPhase.NotFetched]: (count) => t("{count, plural, other {# not downloaded}}", { count }),
  [MakingPhase.NotInGame]: (count) => t("{count, plural, other {# not in your game}}", { count }),
};

/** The jobs that stopped short in one way, in the panel's order, and how. */
function stoppedLists(jobs: AssetInfo[]): Array<{ phase: StoppedPhase; list: AssetInfo[] }> {
  return STOPPED_PHASES.flatMap((phase) => {
    const list = jobs.filter((job) => stoppedShort(job) === phase);
    return list.length ? [{ phase, list }] : [];
  });
}

/** The jobs that stopped short, by how, in the panel's order: each with what it is called. */
export function stoppedGroups(jobs: AssetInfo[]): Array<[string, AssetInfo[]]> {
  return stoppedLists(jobs).flatMap(({ phase, list }) => {
    const title = stoppedTitle(phase);
    return title ? [[title, list] as [string, AssetInfo[]]] : [];
  });
}

/**
 * Where the run's assets have got to, in one line: failures first, then work in hand, then work that
 * stopped short, then (with nothing made) work the run ended before, then the game.
 */
export function assetsStatus(jobs: AssetInfo[]): { text: string; tone: Tone } {
  const made = jobs.filter((job) => job.state === AssetCardState.Delivered);
  const failed = jobs.filter((job) => job.state === AssetCardState.Failed).length;
  const making = jobs.filter(isMaking).length;
  const [stopped] = stoppedLists(jobs);
  const unfinished = jobs.filter((job) => job.state === AssetCardState.Unfinished).length;
  const inGame = made.filter((job) => job.inGame).length;
  const known = made.filter((job) => job.inGame !== undefined).length;
  if (failed) return { text: t("{count, plural, other {# failed}}", { count: failed }), tone: Tone.Red };
  if (making) return { text: t("Making {count}", { count: making }), tone: Tone.Accent };
  if (stopped) return { text: STOPPED_COUNT[stopped.phase](stopped.list.length), tone: Tone.Orange };
  if (unfinished && !made.length) return { text: ASSET_JOB_WORDS.notFinished(unfinished), tone: Tone.Muted };
  if (!known) return { text: t("{count, plural, other {# delivered}}", { count: made.length }), tone: Tone.Muted };
  if (inGame === made.length)
    return { text: t("{count, plural, other {# in game}}", { count: inGame }), tone: Tone.Green };
  if (inGame)
    return {
      text: t("{count} of {total} in game", { count: inGame, total: made.length }),
      tone: Tone.Orange,
    };
  return { text: t("Not in game yet"), tone: Tone.Orange };
}

/** A modeller's render still of an asset, when it has one, keyed by when it was made. */
export const blenderRender = (job: AssetInfo): { run: string; version: string } | null =>
  job.source === BLENDER_SOURCE && job.render ? { run: job.render, version: job.at } : null;

/** A triangle count in words, grouped for reading. */
export const trianglesWords = (triangles: number): string =>
  t("{count, plural, other {{number} triangles}}", {
    count: triangles,
    number: triangles.toLocaleString(intlLocale()),
  });
