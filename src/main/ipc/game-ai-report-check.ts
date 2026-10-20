/**
 * The Report and model-check half of play-time AI's IPC host (`GameAiIpcHost`, registered by
 * `registerGameAiIpc` in `ipc/game-ai.ts`, which has already read each payload): "See what's
 * sent", a Report, the optional model check (D10, on all the creator's own models) and what
 * Publish shows of a game's AI.
 *
 * A project name is still only a name until the library answers for it: the game must be one the
 * library lists, and its folder a real folder — never a link someone put in the library, a file or
 * a folder that is gone — before the check reads its moments or spends the creator's plan or key.
 * A refusal touches nothing.
 */
import { lstat, realpath, stat } from "node:fs/promises";
import type { GameProject } from "../../shared/game-project.ts";
import type { GameAiIpcHost, GameAiModelCheck, GameAiReports } from "../game-ai/types.ts";

const MESSAGE = {
  notInLibrary: (project: string) => `refused: "${project}" is not a game in the library`,
} as const;

/** What the host half needs. */
export interface ReportCheckHostDeps {
  /** The library's games, as `StudioCore.games.list()` answers them. */
  games(): Promise<ReadonlyArray<Pick<GameProject, "name" | "dir">>>;
  check: GameAiModelCheck;
  reports: Pick<GameAiReports, "preview" | "send">;
}

/** The host methods this half answers. */
export type ReportCheckHost = Pick<
  GameAiIpcHost,
  "reportPreview" | "report" | "check" | "checkState" | "checkStop" | "recommend" | "publishFacts"
>;

/** Whether a library entry's folder is a real folder: not a link, not a file, not gone. */
async function isRealFolder(dir: string): Promise<boolean> {
  const link = await lstat(dir).catch(() => null);
  if (!link || link.isSymbolicLink() || !link.isDirectory()) return false;
  const real = await realpath(dir).catch(() => null);
  return real !== null && (await stat(real).catch(() => null))?.isDirectory() === true;
}

/** The Report and model-check host methods over `deps`. */
export function reportCheckIpcHost(deps: ReportCheckHostDeps): ReportCheckHost {
  /** The project, once the library answers for it; throws, touching nothing, when it does not. */
  const libraryGame = async (project: string): Promise<string> => {
    const game = (await deps.games()).find((listed) => listed.name === project);
    if (!game || !(await isRealFolder(game.dir))) throw new Error(MESSAGE.notInLibrary(project));
    return project;
  };

  return {
    reportPreview: (game) => deps.reports.preview(game),
    report: (request) => deps.reports.send(request),
    check: async (project) => deps.check.start(await libraryGame(project), { localOnly: false }),
    checkState: async (project) => deps.check.state(await libraryGame(project)),
    checkStop: async (project) => deps.check.stop(await libraryGame(project)),
    recommend: async (project, model) => deps.check.recommend(await libraryGame(project), model),
    publishFacts: async (project) => deps.check.publishFacts(await libraryGame(project)),
  };
}
