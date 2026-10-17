/**
 * The never-touch list a worker's seat carries (`substrate/engines/never-touch.ts` judges each call
 * against it): what no worker reaches in any mode, Bypass included. A sign-in (the coding CLIs'
 * homes, the sign-in stores no agent process reads, Genex's own login, secrets and engine homes),
 * Genex's own data (this profile's and any other the app named), and every game but the worker's
 * own, less the folders it works in. The sign-ins are at least what a box denies every agent
 * (`baseDenyRead`), and a worker's box denies the whole list in every mode, Bypass included
 * (claude-code.ts `workerSandbox`), so the hook's text screen is a second net. Built by the host
 * from what it knows, never from what the harness says.
 */
import path from "node:path";
import { realpathNearest } from "../../substrate/fsx.ts";
import { type NeverTouchList, NeverTouchKind, type NeverTouchRoot } from "../../substrate/engines/never-touch.ts";

/** Genex's own sign-in, under the home folder. */
const GENEX_LOGIN = ".genex";
/** Where the normal profile keeps its games: a plain folder in the home folder. */
const NORMAL_GAMES = "AI Games";

/** The normal profile's games folder in `home`. */
export function normalGamesFolder(home: string): string {
  return path.join(home, NORMAL_GAMES);
}

/**
 * The normal profile's games folder, for a launch whose own games are elsewhere (a development or
 * test profile, a smoke run): those are other games to every worker of it. None for the normal
 * launch, whose games they are.
 */
export function normalGamesElsewhere(gamesRoot: string | undefined, home: string): string[] {
  const normal = normalGamesFolder(home);
  return gamesRoot !== undefined && path.resolve(gamesRoot) === path.resolve(normal) ? [] : [normal];
}

/** What the list is built from: the host's own knowledge of this Mac and this profile. */
export interface NeverTouchSources {
  home: string;
  /** The coding CLIs' sign-in homes (`credentialHomes`), each whole. */
  credentialHomes: readonly string[];
  /** The sign-in stores every agent's box denies (`baseDenyRead`): SSH keys, keychains, cloud and GitHub logins. */
  signInStores: readonly string[];
  /** Genex's own sign-in folders: its secrets and its engines' homes. */
  genexLogins: readonly string[];
  /** Genex's own data: this profile's data folder and any other profile's the app named. */
  genexData: readonly string[];
  /** Every game's folder but the worker's own. */
  otherGames: readonly string[];
}

/** A root by its real path, as far as it exists: a link must not let its target slip past. */
async function rootOf(target: string, kind: NeverTouchKind): Promise<NeverTouchRoot> {
  const real = await realpathNearest(target).catch(() => path.resolve(target));
  return { path: real, kind };
}

/** The sign-ins: each CLI home whole, the sign-in stores, Genex's login, secrets and engine homes. */
function logins(sources: NeverTouchSources): string[] {
  return [
    ...sources.credentialHomes,
    ...sources.signInStores,
    path.join(sources.home, GENEX_LOGIN),
    ...sources.genexLogins,
  ];
}

/**
 * The never-touch list for a worker working in `open` (its folder, its run's capture folders, its
 * game's folder): those stay reachable even inside a root (a game kept in Genex's data, a copy
 * under its scratch folder).
 */
export async function neverTouchList(sources: NeverTouchSources, open: readonly string[]): Promise<NeverTouchList> {
  const asked: Array<[string, NeverTouchKind]> = [
    ...logins(sources).map((root): [string, NeverTouchKind] => [root, NeverTouchKind.Login]),
    ...sources.genexData.map((root): [string, NeverTouchKind] => [root, NeverTouchKind.GenexData]),
    ...sources.otherGames.map((root): [string, NeverTouchKind] => [root, NeverTouchKind.OtherGame]),
  ];
  const roots = await Promise.all(asked.map(([root, kind]) => rootOf(root, kind)));
  const seen = new Set<string>();
  const unique = roots.filter((root) => !seen.has(root.path) && seen.add(root.path));
  const opened = await Promise.all(open.map((dir) => realpathNearest(dir).catch(() => path.resolve(dir))));
  return { roots: unique, open: [...new Set(opened)] };
}
