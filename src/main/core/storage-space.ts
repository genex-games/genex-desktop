/**
 * What freeing space deletes, and deleting it: shown builds' copies, finished runs' folders and
 * pictures (`../../substrate/storage-folders.ts`), and the history Rewind and finished runs keep in
 * a game's repository (`../../substrate/history-space.ts`). Each game's newest finished build stays
 * whole, as do running, paused and unknown runs, the build Live shows and copies made in the last
 * hour. Freeing never runs in a game that is working, and takes the folder's checkpoint queue, so no
 * chat checkpoint interleaves with it.
 */
import { realpath } from "node:fs/promises";
import path from "node:path";
import { HOUR_MS } from "../../shared/duration.ts";
import { type OutcomeView, outcomeEnded } from "../../shared/run-summary.ts";
import { NO_STORAGE, type StorageFreed, StorageKind, type StorageSpace } from "../../shared/storage-space.ts";
import { clearSideTracks, historySpace } from "../../substrate/history-space.ts";
import { isInside } from "../../substrate/paths.ts";
import { diskBytes, type OwnedFolder, ownedFolders, removeOwnedFolder } from "../../substrate/storage-folders.ts";
import type { GameHistorySpace } from "../../shared/game-history.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";
import { safePathSegment } from "./run-shots.ts";

const MESSAGE = {
  busy: "Wait for this game's work to finish, then free its space.",
  unknownGame: (project: string) => `There is no game named "${project}".`,
} as const;

/** Where shown builds' copies are made under scratch (`previews.ts` `showBuild`). */
const SHOWN_COPIES = ["show"] as const;
/** Where runs make their copies of the game under scratch, one folder per run. */
const RUN_COPIES = ["autopilot"] as const;
/** A shown build's copy: `<game>-<its commit's first 12 hex>-<8 hex>`; an older one is `<game>`. */
const SHOWN_COPY = /^(.+)-[0-9a-f]{12}-[0-9a-f]{8}$/;
/** How long a shown build's copy stays: one being shown right now may not be served yet. */
const FRESH_COPY_MS = HOUR_MS;
/** How many games' histories are measured at once. */
const MEASURE_CONCURRENCY = 4;

/** A folder freeing deletes: where it is, the kind of space it is and whose game it was. */
interface Holding {
  root: string;
  parts: readonly string[];
  folder: OwnedFolder;
  kind: StorageKind;
  project: string;
}

/** The finished runs freeing deletes, by game: every one but the game's newest. */
type OldRuns = ReadonlyMap<string, ReadonlySet<string>>;

const NO_RUNS: ReadonlySet<string> = new Set();

/** The game a shown build's copy was made of. */
const shownGame = (name: string): string => SHOWN_COPY.exec(name)?.[1] ?? name;

/** A fresh tally of nothing. */
const noStorage = (): StorageSpace => ({ bytes: { ...NO_STORAGE.bytes } });

/** What freeing space deletes, and deleting it, in one game or in all of them. */
export class StorageSpaceService {
  readonly #core: StudioCore;
  readonly #x: CoreInternals;

  constructor(core: StudioCore, x: CoreInternals) {
    this.#core = core;
    this.#x = x;
  }

  /**
   * What freeing deletes now: in `project` (nothing while it works), or, with no game named, in
   * every game that is not working and what games no longer listed left.
   */
  async space(project?: string): Promise<StorageSpace> {
    if (project !== undefined) return this.#gameSpace(project);
    const games = (await this.#core.games.list()).map((game) => game.name);
    const listed = new Set(games);
    const idle: string[] = [];
    for (const game of games) if ((await this.#allowedDir(game)) && !(await this.#busy(game))) idle.push(game);
    const idleGames = new Set(idle);
    const old = await this.#oldRuns();
    const space = noStorage();
    for (const holding of await this.#holdings(old)) {
      if (idleGames.has(holding.project) || !listed.has(holding.project))
        space.bytes[holding.kind] += await diskBytes(holding.folder.dir);
    }
    for (let at = 0; at < idle.length; at += MEASURE_CONCURRENCY) {
      const batch = idle.slice(at, at + MEASURE_CONCURRENCY);
      for (const history of await Promise.all(batch.map((game) => this.#history(game, old))))
        addHistory(space, history);
    }
    return space;
  }

  /**
   * Free space: in `project` (refused while it works), or, with no game named, in every game that
   * is not working (the rest are named in `skipped`) and what games no longer listed left.
   */
  async free(project?: string): Promise<StorageFreed> {
    if (project !== undefined) {
      const freed = await this.#freeGame(project, await this.#gameDir(project));
      if (freed === null) throw new Error(MESSAGE.busy);
      return { freedBytes: freed, skipped: [] };
    }
    const games = (await this.#core.games.list()).map((game) => game.name);
    const skipped: string[] = [];
    let freedBytes = 0;
    for (const game of games) {
      const dir = await this.#allowedDir(game);
      if (!dir) continue;
      const freed = await this.#freeGame(game, dir);
      if (freed === null) skipped.push(game);
      else freedBytes += freed;
    }
    const listed = new Set(games);
    for (const holding of await this.#holdings(await this.#oldRuns()))
      if (!listed.has(holding.project)) freedBytes += await this.#remove(holding);
    return { freedBytes, skipped };
  }

  async #gameSpace(project: string): Promise<StorageSpace> {
    await this.#gameDir(project);
    const space = noStorage();
    if (await this.#busy(project)) return space;
    const old = await this.#oldRuns();
    for (const holding of await this.#holdings(old))
      if (holding.project === project) space.bytes[holding.kind] += await diskBytes(holding.folder.dir);
    addHistory(space, await this.#history(project, old));
    return space;
  }

  /** Free `project`'s space, folders first so the history clear forgets their worktrees; null while it works. */
  async #freeGame(project: string, dir: string): Promise<number | null> {
    if (await this.#busy(project)) return null;
    return this.#x.rewind.checkpoints.exclusive(dir, async () => {
      if (await this.#busy(project)) return null;
      const old = await this.#oldRuns();
      let freed = 0;
      for (const holding of await this.#holdings(old))
        if (holding.project === project) freed += await this.#remove(holding);
      const scratch = this.#core.layout.scratch;
      return freed + (await clearSideTracks(dir, old.get(project) ?? NO_RUNS, { scratch })).freedBytes;
    });
  }

  /** What a game's history holds for Rewind and its old runs; nothing for a folder Genex may not change. */
  async #history(project: string, old: OldRuns): Promise<GameHistorySpace | null> {
    const dir = await this.#allowedDir(project);
    return dir ? historySpace(dir, old.get(project) ?? NO_RUNS) : null;
  }

  /** Delete one folder freeing found, unless it is a shown build Live serves by now. */
  async #remove(holding: Holding): Promise<number> {
    const shown = holding.parts === SHOWN_COPIES;
    if (shown && (await this.#served(holding.folder.dir))) return 0;
    return removeOwnedFolder(holding.root, holding.parts, holding.folder.name);
  }

  /**
   * Every folder freeing deletes: old runs' pictures and copies, and shown builds' copies that are
   * neither served nor made in the last hour.
   */
  async #holdings(old: OldRuns): Promise<Holding[]> {
    const gameOfRun = new Map<string, string>();
    for (const [project, runs] of old) for (const runId of runs) gameOfRun.set(safePathSegment(runId), project);
    const { scratch, runs } = this.#core.layout;
    const holdings: Holding[] = [];
    const ofRun = async (root: string, parts: readonly string[], kind: StorageKind) => {
      for (const folder of await ownedFolders(root, parts)) {
        const project = gameOfRun.get(folder.name);
        if (project) holdings.push({ root, parts, folder, kind, project });
      }
    };
    await ofRun(runs, [], StorageKind.Pictures);
    await ofRun(scratch, RUN_COPIES, StorageKind.Copies);
    const now = Date.now();
    for (const folder of await ownedFolders(scratch, SHOWN_COPIES)) {
      if (now - folder.changedAt < FRESH_COPY_MS || (await this.#served(folder.dir))) continue;
      holdings.push({
        root: scratch,
        parts: SHOWN_COPIES,
        folder,
        kind: StorageKind.Copies,
        project: shownGame(folder.name),
      });
    }
    return holdings;
  }

  /** Whether a preview serves `dir` or a folder inside it. */
  async #served(dir: string): Promise<boolean> {
    for (const { root } of this.#x.servedRoots.values()) {
      if (!root) continue;
      const real = await realpath(root).catch(() => path.resolve(root));
      if (isInside(dir, real) || isInside(dir, root)) return true;
    }
    return false;
  }

  /**
   * The runs of each game that ended and are not going any more, but its newest finished one (its
   * latest build): Activity lists runs newest first, so the first finished run of a game is the one
   * that stays, and failed or cancelled runs after it never take its place.
   */
  async #oldRuns(): Promise<OldRuns> {
    const newest = new Map<string, string>();
    const old = new Map<string, Set<string>>();
    for (const { project, runId, runOutcome } of await this.#core.activityItems()) {
      if (!project || !runId || !runOutcome) continue;
      if (!outcomeEnded(runOutcome) || this.#x.activeRunIds.has(runId)) continue;
      const kept = newest.get(project);
      if (kept === runId) continue;
      if (kept === undefined && isBuild(runOutcome)) newest.set(project, runId);
      else old.set(project, (old.get(project) ?? new Set()).add(runId));
    }
    return old;
  }

  /** The folder of a game the library lists, inside the folders the studio may change. */
  async #gameDir(project: string): Promise<string> {
    const listed = (await this.#core.games.list()).some((game) => game.name === project);
    if (!listed) throw new Error(MESSAGE.unknownGame(project));
    const dir = this.#core.games.dirFor(project);
    await this.#core.assertProjectAllowed(dir);
    return dir;
  }

  /** A listed game's folder, or null when the studio may not change it. */
  async #allowedDir(project: string): Promise<string | null> {
    const dir = this.#core.games.dirFor(project);
    try {
      await this.#core.assertProjectAllowed(dir);
      return dir;
    } catch {
      return null;
    }
  }

  /**
   * Whether a contractor builds in `project` now, or a run is going that is its own or that no
   * record ties to a game yet.
   */
  async #busy(project: string): Promise<boolean> {
    if ([...this.#x.activeDelegations.values()].some((work) => work.project === project)) return true;
    if (this.#x.activeRunIds.size === 0) return false;
    const gameOfRun = new Map<string, string | undefined>();
    for (const item of await this.#core.activityItems()) if (item.runId) gameOfRun.set(item.runId, item.project);
    return [...this.#x.activeRunIds].some((runId) => {
      const game = gameOfRun.get(runId);
      return game === undefined || game === project;
    });
  }
}

/** Whether a run that ended left a build: it finished, rather than failing or being cancelled. */
function isBuild(outcome: OutcomeView): boolean {
  return outcome.state === "finished";
}

/** Add what a game's history frees now to `space`; what is under an hour old waits for a later clean-up. */
function addHistory(space: StorageSpace, history: GameHistorySpace | null): void {
  if (history) space.bytes[StorageKind.History] += history.clearableBytes;
}
