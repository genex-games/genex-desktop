/**
 * The Publish dialog's platform rows for one game (`studio:plugins.genex-publish-platforms`): the
 * web build as Publish sends it, and the Mac, Windows and Linux apps the game folder holds, each ready,
 * built before the game's last change, or not built yet. A ready app goes with Publish once the
 * pinned Genex CLI can send apps (`publishedApps`). Read from the folder only; nothing is built or
 * uploaded here.
 */
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { MINUTE_MS } from "../../shared/duration.ts";
import { NativePlatform } from "../../shared/play-native.ts";
import { publishesAsWebGame } from "../../shared/project-workspace.ts";
import { pinnedCliSendsApps } from "../../plugins/genex/native-publish.ts";
import { type PublishPlatform, PublishPlatformState, PublishTarget } from "../../shared/publish-platforms.ts";
import type { StudioCore } from "../studio-core.ts";
import { type FoundBuild, findNativeBuilds } from "./native-builds.ts";

/** How much newer than a build the game's last change must be before the build counts as old. */
const STALE_AFTER_MS = MINUTE_MS;
/** How many entries the look for the game's last change reads at most. */
const CHANGE_ENTRIES_MAX = 20_000;
/**
 * Folders whose changes are not the game's: history, packages, caches, builds, exports and an
 * editor's own state (Unity's UserSettings: its window layout is saved after every build). Every
 * hidden folder is skipped too (`.git`, `.studio`, `.vscode`).
 */
const NOT_SOURCE = new Set([
  "UserSettings",
  "node_modules",
  "Library",
  "Temp",
  "Logs",
  "obj",
  "Builds",
  "Build",
  "build",
  "dist",
  "export",
  "exports",
  "web",
  "Intermediate",
  "Saved",
  "DerivedDataCache",
  "Binaries",
]);

const MESSAGE = { NoGame: "not a game in the library" } as const;

/** Files whose changes are not the game's: notes an agent keeps, logs, and hidden files such as Finder's `.DS_Store`. */
const NOT_SOURCE_FILE = /^\.|\.(md|log)$/i;

/** Whether a folder holds the game's sources: not hidden, a cache, an export, a bundle or a found build's folder. */
const isSource = (name: string, at: string, builds: ReadonlySet<string>): boolean =>
  !name.startsWith(".") && !NOT_SOURCE.has(name) && !name.endsWith(".app") && !builds.has(at);

/** Whether `build` is older than the game's last change (`changed`, ms since the epoch): not what players should get. */
export const isStaleBuild = (build: Pick<FoundBuild, "builtAt">, changed: number): boolean =>
  changed - build.builtAt > STALE_AFTER_MS;

/** When the game's sources last changed, ms since the epoch, outside its builds and caches. */
export async function lastChange(root: string, builds: readonly FoundBuild[]): Promise<number> {
  // A build's own folder, and the folder its program sits in (a Mac app's holds the app's debug symbols).
  const inBuild = new Set(
    builds.flatMap((build) => [
      path.join(root, ...build.folder.split("/")),
      path.join(root, build.entry.split("/").slice(0, -1).join("/") || "."),
    ]),
  );
  let newest = 0;
  let seen = 0;
  const pending = [root];
  for (let dir = pending.pop(); dir !== undefined && seen < CHANGE_ENTRIES_MAX; dir = pending.pop()) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    seen += entries.length;
    for (const entry of entries) {
      const at = path.join(dir, entry.name);
      if (entry.isDirectory() && isSource(entry.name, at, inBuild)) pending.push(at);
      if (entry.isFile() && !NOT_SOURCE_FILE.test(entry.name))
        newest = Math.max(newest, (await stat(at).catch(() => null))?.mtimeMs ?? 0);
    }
  }
  return newest;
}

/** A platform's row from its newest build, or its missing row; a ready build goes with Publish when the CLI sends apps. */
function nativeRow(
  target: Exclude<PublishTarget, typeof PublishTarget.Web>,
  build: FoundBuild | undefined,
  changed: number,
  sendsApps: boolean,
): PublishPlatform {
  if (!build)
    return { target, state: PublishPlatformState.Missing, arch: null, bytes: 0, builtAt: null, uploads: false };
  const stale = isStaleBuild(build, changed);
  return {
    target,
    state: stale ? PublishPlatformState.Stale : PublishPlatformState.Ready,
    arch: build.arch,
    bytes: build.bytes,
    builtAt: new Date(build.builtAt).toISOString(),
    // A build older than the game's last change is not what players should get: it stays here.
    uploads: sendsApps && !stale,
  };
}

/** What a game's folder holds for Publish: whether it is a web game, its newest app per platform, its last change. */
async function folderFacts(core: Pick<StudioCore, "games" | "pluginBinding">, project: unknown) {
  if (typeof project !== "string" || !project) throw new Error(MESSAGE.NoGame);
  const game = (await core.games.list()).find((listed) => listed.name === project);
  const binding = game ? await core.pluginBinding(project) : undefined;
  if (!game || !binding) throw new Error(MESSAGE.NoGame);
  const builds = await findNativeBuilds(binding.directory);
  const changed = await lastChange(binding.directory, builds);
  const newest = (platform: NativePlatform) => builds.find((build) => build.platform === platform);
  return {
    web: publishesAsWebGame(game),
    mac: newest(NativePlatform.Mac),
    windows: newest(NativePlatform.Windows),
    linux: newest(NativePlatform.Linux),
    changed,
  };
}

/** The web, Mac, Windows and Linux rows for `project`, from its folder. */
export async function publishPlatforms(
  core: Pick<StudioCore, "games" | "pluginBinding">,
  project: unknown,
  sendsApps = pinnedCliSendsApps(),
): Promise<PublishPlatform[]> {
  const { web, mac, windows, linux, changed } = await folderFacts(core, project);
  const rows: PublishPlatform[] = [
    {
      target: PublishTarget.Web,
      state: web ? PublishPlatformState.Ready : PublishPlatformState.Missing,
      arch: null,
      bytes: 0,
      builtAt: null,
      uploads: web,
    },
    nativeRow(PublishTarget.Mac, mac, changed, sendsApps),
    nativeRow(PublishTarget.Windows, windows, changed, sendsApps),
    nativeRow(PublishTarget.Linux, linux, changed, sendsApps),
  ];
  if (changed <= 0) return rows;
  const changedAt = new Date(changed).toISOString();
  return rows.map((row) => ({ ...row, changedAt }));
}

/** Which apps a send takes beyond Publish's own: one platform's newest whatever its age, or only builds newer than a time. */
export interface AppsChoice {
  /** This platform's newest build, even when it is older than the game's last change: the build a person is asked to read. */
  force?: string;
  /** Only builds made after this time (ms since the epoch): what the agent built after a fix press. */
  builtAfter?: number;
  /** Only these platforms' builds: the ones the Publish card's switches send. */
  platforms?: readonly string[];
}

/**
 * The apps a Publish of `project` sends, by their place in its folder: each platform's newest build
 * that is not older than the game's last change (with `choice`, see {@link AppsChoice}). None while
 * the CLI cannot send apps.
 */
export async function publishedApps(
  core: Pick<StudioCore, "games" | "pluginBinding">,
  project: unknown,
  sendsApps = pinnedCliSendsApps(),
  choice: AppsChoice = {},
): Promise<string[]> {
  if (!sendsApps) return [];
  const { mac, windows, linux, changed } = await folderFacts(core, project);
  const chosen = (build: FoundBuild): boolean => choice.platforms?.includes(build.platform) ?? true;
  const builds = [mac, windows, linux].filter((build): build is FoundBuild => build !== undefined && chosen(build));
  if (choice.force !== undefined) return builds.filter((build) => build.platform === choice.force).map((b) => b.entry);
  const after = choice.builtAfter ?? Number.NEGATIVE_INFINITY;
  return builds.filter((build) => !isStaleBuild(build, changed) && build.builtAt > after).map((build) => build.entry);
}
