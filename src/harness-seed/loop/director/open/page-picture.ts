/**
 * Genex's own picture of a web game's page at a save point. A web game has no plugin whose
 * checkpoint steps take pictures, so a save point whose lead named none (`save_point {shows}`) would
 * keep no picture at all, and the Builds graph would draw its card, the lead's and the build's blank.
 * Genex looks at the page as it takes a build's picture (`pagePicture`, loop/page-look.ts): in a
 * window of its own, never the person's Live. A module of its own, so the shipped tools need no new
 * name from a module an agent may have kept.
 */
import type { FactsOfDescriptor } from "../../folder-facts.ts";
import { pageChecked } from "../../folder-facts.ts";
import { pagePicture } from "../../page-look.ts";
import { HostMethod } from "../../host-methods.ts";
import type { LoopRun } from "../loop-run.ts";

/**
 * The camera Genex's own picture is filed under: the one the graph's cards lead with
 * (`thumbShot`). Persisted in `facet_iteration.shots`: never rename the value.
 */
export const PAGE_CAMERA = "default";

/**
 * The name the finish's look at the page files its picture under in the run's folder (a JPEG): the
 * build a Loop that closed on its lead's claim closed on. The app reads it there for a past run's
 * build (`OPEN_FINISH_PICTURE_LABEL`, shared/run-summary.ts). Persisted: never rename the value.
 */
export const FINISH_PICTURE_LABEL = "director/finish";

/**
 * The game as the host lists it now: the Loop may have changed what its folder holds (an engine's
 * project made in it). The Loop's start's reading when the host can't list it.
 */
export async function gameNow(loopRun: LoopRun): Promise<FactsOfDescriptor> {
  const { ctx, gameFacts, open, run } = loopRun;
  const games = await ctx.call(HostMethod.GameList).catch(() => null);
  const listed = Array.isArray(games) ? games.find((game) => game.name === run.project) : undefined;
  return listed ?? { facts: gameFacts, holds: open.holds };
}

/** Genex's picture of the page at save point `round`, or null for a game that is no web page. */
async function pageAt(loopRun: LoopRun, round: number): Promise<{ camera: string; path: string } | null> {
  const { ctx, run } = loopRun;
  if (ctx.cancelled || !pageChecked(await gameNow(loopRun))) return null;
  const target = { project: run.project, runId: run.runId, label: `open/save-${round}/${PAGE_CAMERA}` };
  const path = await pagePicture(ctx, target, { sleep: loopRun.open.clock.sleep });
  return path ? { camera: PAGE_CAMERA, path } : null;
}

/**
 * Genex's picture of the page at save point `round`, filed in the run's folder beside the save
 * point's other pictures; null for a game that is no web page, or when no picture could be taken.
 * Never throws: a picture that could not be taken never costs the save point its record.
 */
export async function savePointPagePicture(
  loopRun: LoopRun,
  round: number,
): Promise<{ camera: string; path: string } | null> {
  try {
    return await pageAt(loopRun, round);
  } catch {
    return null;
  }
}
