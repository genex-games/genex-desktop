/**
 * The review watch and the review card's presses over the real core: every Genex call through the
 * Genex plugin's actions on the bound game, records in the game's own chat, the game's apps from its
 * folder (`publishedApps`). The games the watch reads are those whose publish record has a link on
 * Genex. In a fixture profile nothing reads Genex: the record the fixture laid down is answered as kept.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CustomEvent, customEventData, customRecord } from "../../shared/custom-events.ts";
import type { EventData } from "../../shared/event-log.ts";
import { readRequestAnswer, readReviewStatus } from "../../plugins/genex/native-review.ts";
import { GENEX_PLUGIN_ID, GenexAction, GenexHostedStatus } from "../../shared/genex.ts";
import type { GenexReviewRequestAnswer, GenexReviewStatus, GenexReviewTold } from "../../shared/genex-review.ts";
import { publishesAsWebGame } from "../../shared/project-workspace.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import type { StudioCore } from "../studio-core.ts";
import { publishAppsFromDialog } from "./genex-publish.ts";
import type { GenexReviewDeps } from "./genex-review.ts";
import type { ReviewLinesDeps } from "./genex-review-lines.ts";
import type { ReviewWatchDeps } from "./genex-review-watch.ts";
import { publishedApps } from "./publish-platforms.ts";

/** What the wiring needs of the core. */
export type ReviewHostCore = Pick<
  StudioCore,
  | "games"
  | "plugins"
  | "pluginBinding"
  | "publicCopyFiles"
  | "withApprovedExport"
  | "threadForGame"
  | "existingGameThread"
  | "store"
  | "append"
  | "sendUserMessage"
  | "pluginServices"
  | "emit"
>;

const MESSAGE = {
  NoGame: "not a game in the library",
  NotAStatus: "the Genex plugin answered no review",
  NotAnAnswer: "the Genex plugin answered no request",
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** A Genex plugin action on the game, bound as Studio binds it. */
async function genexAction(core: ReviewHostCore, project: string, name: string, args: Record<string, unknown>) {
  const binding = await core.pluginBinding(project);
  if (!binding) throw new Error(MESSAGE.NoGame);
  return core.plugins.action(GENEX_PLUGIN_ID, name, args, binding);
}

/**
 * The Genex plugin's `review-status` for the game. `reads` false (a fixture profile) never asks Genex:
 * the kept record is answered as it is.
 */
export async function reviewStatusOf(
  core: ReviewHostCore,
  project: string,
  options: { refresh?: boolean; told?: GenexReviewTold },
  reads: boolean,
): Promise<GenexReviewStatus> {
  const args = {
    ...(options.refresh && reads ? { refresh: true } : {}),
    ...(options.told ? { told: options.told } : {}),
  };
  const status = readReviewStatus(await genexAction(core, project, GenexAction.ReviewStatus, args));
  if (!status) throw new Error(MESSAGE.NotAStatus);
  return status;
}

/** The Genex plugin's `review-request` for the game, with the apps a person may need sent again. */
async function requestOf(core: ReviewHostCore, project: string, args: Record<string, unknown>) {
  const answer = readRequestAnswer(await genexAction(core, project, GenexAction.ReviewRequest, args));
  if (!answer) throw new Error(MESSAGE.NotAnAnswer);
  return answer;
}

/** The game chat's log, read without making a chat for a game that has none. */
async function gameEvents(core: ReviewHostCore, project: string) {
  const threadId = await core.existingGameThread(project);
  return threadId ? core.store.listEvents(threadId) : [];
}

/** One of the game's records in the Genex plugin's storage, as JSON; null when it is missing or not JSON. */
async function publishRecord(
  core: ReviewHostCore,
  project: string,
  file: string,
): Promise<Record<string, unknown> | null> {
  const dir = path.join(core.pluginServices.root(GENEX_PLUGIN_ID), "publish", project);
  const read = await readFile(path.join(dir, file), "utf8").catch(() => "");
  try {
    const parsed: unknown = JSON.parse(read);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The game's link on Genex, from its publish record or the CLI's link beside it; undefined when it has none. */
async function slugOf(core: ReviewHostCore, project: string): Promise<string | undefined> {
  for (const file of ["publish.json", path.join(".genex", "project.json")]) {
    const slug = (await publishRecord(core, project, file))?.slug;
    if (typeof slug === "string" && slug) return slug;
  }
  return undefined;
}

/** Whether the game's publish record says it is listed on Genex. */
async function listedOnGenex(core: ReviewHostCore, project: string): Promise<boolean> {
  return (await publishRecord(core, project, "publish.json"))?.status === GenexHostedStatus.Published;
}

/** The library's game whose publish record has `slug` on Genex; null when none has. */
export async function gameOfSlug(core: ReviewHostCore, slug: string): Promise<string | null> {
  for (const project of await gamesOnGenex(core)) if ((await slugOf(core, project)) === slug) return project;
  return null;
}

/** The library's games on Genex, while the Genex plugin is on. */
export async function gamesOnGenex(core: ReviewHostCore): Promise<string[]> {
  if (!core.plugins.enabled(GENEX_PLUGIN_ID)) return [];
  const games = await core.games.list();
  const linked = await Promise.all(games.map(async (game) => ((await slugOf(core, game.name)) ? game.name : null)));
  return linked.filter((name): name is string => name !== null);
}

/** The game's name, link and whether it is a web game. */
async function gameOf(core: ReviewHostCore, project: string) {
  const game = (await core.games.list()).find((listed) => listed.name === project);
  if (!game) throw new Error(MESSAGE.NoGame);
  const slug = await slugOf(core, project);
  return { title: game.title || project, ...(slug ? { slug } : {}), web: publishesAsWebGame(game) };
}

/** The games review records are about, each once. */
function recordsProjects(records: readonly EventData[]): string[] {
  const projects = records.map((record) => customRecord(record)?.payload.project);
  return [...new Set(projects.filter((project): project is string => typeof project === "string" && project !== ""))];
}

/** The watch over the core. */
export function reviewWatchDeps(core: ReviewHostCore, reads: boolean): ReviewWatchDeps {
  return {
    now: () => Date.now(),
    setTimer: (run, ms) => {
      const timer = setTimeout(run, ms);
      timer.unref?.();
      return timer;
    },
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    games: () => gamesOnGenex(core),
    status: (project, options) => reviewStatusOf(core, project, options, reads),
    append: async (project, records) => {
      const threadId = await core.threadForGame(project);
      await core.append(
        records.map((record) => customEventData(CustomEvent.GenexReview, { ...record })),
        threadId,
      );
    },
    emit: (project) => core.emit(UiEvent.GenexReviewChanged, { project }),
    game: async (project) => {
      const { title, slug } = await gameOf(core, project);
      return { title, ...(slug ? { slug } : {}) };
    },
  };
}

/** The sidebar's lines over the core: the kept review only, never a read of Genex. */
export function reviewLinesDeps(core: ReviewHostCore): ReviewLinesDeps {
  return {
    games: () => gamesOnGenex(core),
    status: (project) => reviewStatusOf(core, project, {}, false),
    events: (project) => gameEvents(core, project),
    published: (project) => listedOnGenex(core, project),
  };
}

/** The review card's presses over the core; `refresh` reads the game's review again on the watch. */
export function reviewFlowDeps(
  core: ReviewHostCore,
  reads: boolean,
  refresh: (project: string) => void,
): GenexReviewDeps {
  return {
    status: (project, options = {}) => reviewStatusOf(core, project, options, reads),
    thread: (project) => core.threadForGame(project),
    existingThread: (project) => core.existingGameThread(project),
    game: (project) => gameOf(core, project),
    events: (threadId) => core.store.listEvents(threadId),
    append: async (threadId, records) => {
      await core.append(records, threadId);
      // A press or Studio's step after it changes the game's line and its bell row: say so.
      for (const project of recordsProjects(records)) core.emit(UiEvent.GenexReviewChanged, { project });
    },
    send: (text, options) => core.sendUserMessage(text, options),
    apps: (project, choice) => publishedApps(core, project, undefined, choice),
    publishApps: (project) => publishAppsFromDialog(core, project),
    resendApps: async (project, native) => {
      await genexAction(core, project, GenexAction.AppsResend, { native });
    },
    request: (project, args): Promise<GenexReviewRequestAnswer> => requestOf(core, project, args),
    refresh,
    changed: (project) => core.emit(UiEvent.GenexReviewChanged, { project }),
    now: () => Date.now(),
    id: () => randomUUID(),
  };
}
