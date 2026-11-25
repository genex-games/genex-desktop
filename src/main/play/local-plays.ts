/**
 * Play for a game being made: Genex starts the newest app the game's own folder holds for this
 * computer (an Unreal package in `unreal/Builds/Mac/`, say), in the same game sandbox and full
 * screen as a game from Play (`native-launch.ts`). The app runs where it is, read-only: nothing is
 * copied, re-signed or written into the game folder, so what Publish sends stays as the agent built
 * it; its saves and temporary files live in Genex's own folder. An app older than the game's last
 * change (`isStaleBuild`, the rule Publish keeps) is not played: the chat's agent packages again
 * first. One copy of a game runs at a time; Play again brings its window forward.
 * Electron-free: the launcher, the folder's builds and the clock are deps.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { isPlaySlug } from "../../shared/play.ts";
import {
  LocalPlayState,
  type LocalPlayAnswer,
  NativeArch,
  type NativeHost,
  NativeSessionPhase,
  type NativePlatform,
  launchesOn,
} from "../../shared/play-native.ts";
import { bundleIdentity, type FoundBuild } from "../core/native-builds.ts";
import type { InstallRecord } from "./native-installs.ts";
import type { NativeSessions } from "./native-launch.ts";

/** A game folder's saves, by its slug, inside Genex's own folder for local plays. */
const SAVES = "saves";
/** How many characters of a project name's hash name a game whose name is no slug. */
const HASH_CHARS = 12;

/** What playing a game folder's own app needs. */
export interface LocalPlaysDeps {
  /** Genex's own folder for local plays: the launcher's records, each game's saves. */
  root: string;
  /** This computer, or null where Genex can't tell. */
  host: NativeHost | null;
  /** The game's folder, or null for a game Genex doesn't know. */
  gameDir(project: string): Promise<string | null>;
  /** The app builds the folder holds, newest first (`findNativeBuilds`). */
  builds(dir: string): Promise<FoundBuild[]>;
  /** When the folder's sources last changed, ms since the epoch (`lastChange`). */
  lastChange(dir: string, builds: readonly FoundBuild[]): Promise<number>;
  /** Whether a build is older than that change (`isStaleBuild`). */
  stale(build: FoundBuild, changed: number): boolean;
  /** The launcher, given where each game's app and saves are and the record of the app it plays. */
  sessions(place: LocalPlacing): NativeSessions;
}

/** The launcher's view of what it plays: each game's record and where its app and saves are. */
export interface LocalPlacing {
  /** The game a launch's name stands for, or null for one this launcher never started. */
  project(slug: string): string | null;
  record(slug: string): Promise<InstallRecord | null>;
  place(slug: string, record: InstallRecord): { app: string; saves: string };
}

/** The name a game's launch goes by: its own name when that is a slug, else one made from its hash. */
export function localSlug(project: string): string {
  if (isPlaySlug(project)) return project;
  return `game-${createHash("sha256").update(project).digest("hex").slice(0, HASH_CHARS)}`;
}

/** Whether a build's app runs on `host`: its own processor, a universal Mac app, or Intel under Rosetta. */
export function runsHere(build: Pick<FoundBuild, "platform" | "arch">, host: NativeHost): boolean {
  if (build.platform !== host.platform) return false;
  if (build.arch === host.arch || build.arch === NativeArch.Universal) return true;
  return build.arch === NativeArch.X64 && host.arch === NativeArch.Arm64 && host.rosetta === true;
}

/** A path inside the game as forward slashes split into its parts. */
const partsOf = (relative: string) => relative.split("/");

/** The launcher's record of a game folder's build: its app, the program inside it and what macOS names it by. */
async function recordOf(slug: string, dir: string, build: FoundBuild, platform: NativePlatform) {
  const app = path.join(dir, ...partsOf(build.folder));
  const executable = path.relative(app, path.join(dir, ...partsOf(build.program)));
  const identity = build.folder.endsWith(".app") ? await bundleIdentity(app) : { id: null, name: null };
  const record: InstallRecord = {
    slug,
    title: slug,
    coverUrl: null,
    version: String(Math.round(build.builtAt)),
    platform,
    arch: build.arch,
    bytes: build.bytes,
    installedAt: new Date(build.builtAt).toISOString(),
    lastPlayedAt: null,
    entry: ".",
    engine: null,
    executable,
    bundleId: identity.id ?? slug,
    bundleName: identity.name ?? path.basename(executable),
    windowed: false,
  };
  return { record, app };
}

/** The games being made that Genex plays from their own folders (module comment). */
export class LocalPlays {
  readonly #deps: LocalPlaysDeps;
  readonly #records = new Map<string, { record: InstallRecord; app: string; project: string }>();
  readonly #sessions: NativeSessions;

  constructor(deps: LocalPlaysDeps) {
    this.#deps = deps;
    this.#sessions = deps.sessions({
      project: (slug) => this.#records.get(slug)?.project ?? null,
      record: async (slug) => this.#records.get(slug)?.record ?? null,
      place: (slug, record) => ({
        app: this.#records.get(slug)?.app ?? record.entry,
        saves: path.join(deps.root, slug, SAVES),
      }),
    });
  }

  /** The launcher itself: its records to reconcile at start, its games to end when Genex quits. */
  get sessions(): NativeSessions {
    return this.#sessions;
  }

  /** Whether `slug`'s game runs now (starting or on screen). */
  #running(slug: string): boolean {
    return this.#sessions.sessions().some((one) => one.slug === slug && one.phase !== NativeSessionPhase.Failed);
  }

  /**
   * Play `project`'s newest app for this computer: started (or, already running, brought forward),
   * or why not: none built, one older than the game's last change, or a computer Genex can't play on.
   */
  async play(project: string, engine: string | null = null): Promise<LocalPlayAnswer> {
    const host = this.#deps.host;
    if (!host || !launchesOn(host)) return { state: LocalPlayState.Unsupported };
    const slug = localSlug(project);
    if (this.#running(slug)) {
      await this.#sessions.show(slug);
      return { state: LocalPlayState.Shown };
    }
    const dir = await this.#deps.gameDir(project);
    if (!dir) return { state: LocalPlayState.NoBuild };
    const builds = await this.#deps.builds(dir);
    const build = builds.find((one) => runsHere(one, host));
    if (!build) return { state: LocalPlayState.NoBuild };
    if (this.#deps.stale(build, await this.#deps.lastChange(dir, builds)))
      return { state: LocalPlayState.Stale, app: build.entry };
    const placed = await recordOf(slug, dir, build, host.platform);
    this.#records.set(slug, { ...placed, project, record: { ...placed.record, engine } });
    await this.#sessions.launch(slug);
    const state = this.#running(slug) ? LocalPlayState.Launched : LocalPlayState.Failed;
    return { state, app: build.entry };
  }
}
