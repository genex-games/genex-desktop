/**
 * The native-games fixture: the fixture catalog's Mac apps built on this Mac (`fixture-native-app.ts`)
 * and zipped into the profile, so its build host serves real archives; then, in a fresh profile,
 * Frigate installed and Puck Rush installed one version behind the catalog, through the real
 * installer, and a Mac build of the library's own game in its folder, so Publish lists its
 * platforms. A reused profile keeps what it has installed.
 */
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { PlayGameDetail } from "../../shared/play.ts";
import { type NativeHost, parseNativeBuilds } from "../../shared/play-native.ts";
import { diskBytes } from "../../substrate/storage-folders.ts";
import { nativeInstalls } from "../play/native-installs.ts";
import { runTool } from "../play/native-unpack.ts";
import { MINUTE_MS } from "../../shared/duration.ts";
import { buildFixtureApp } from "./fixture-native-app.ts";
import {
  type FixtureBuildSpec,
  type FixtureNativeGame,
  fixtureBuildRow,
  fixtureNativeFetch,
  macApp,
  prepareFixtureArchives,
  SMALL,
} from "./fixture-native.ts";
import { buildHostsFor } from "../play/gallery.ts";

/** The made-up level data that gives a stand-in its size: not compressible, the same every launch. */
const LEVEL_FILE = "level.pak";
/** How long zipping one stand-in app may take. */
const ZIP_TIMEOUT_MS = MINUTE_MS;
/** Puck Rush as it was one version ago: what the fixture installs so an update waits. */
const PUCK_RUSH_BEFORE: FixtureBuildSpec = {
  ...macApp("Puck Rush", "1.2", SMALL),
  publishedAt: "2026-10-01T09:00:00.000Z",
};
/** The marker a profile's first preparation leaves: what it installs at start is installed once. */
const SEEDED = ".installed-at-start";
/** The games a fresh native-games profile has installed. */
const INSTALLED_AT_START = ["frigate"] as const;
/** Where in the library game's folder its Mac build goes, as an engine's build would. */
const LIBRARY_BUILD = path.join("Builds", "Mac");

/** What preparing the fixture needs from the launch. */
export interface NativeGamesFixtureDeps {
  /** The profile's own folder for the made archives. */
  dir: string;
  /** The profile's installed-games folder. */
  root: string;
  host: NativeHost;
  games: readonly FixtureNativeGame[];
  /** A game's page from the fixture catalog. */
  page(slug: string): Promise<PlayGameDetail>;
  /** The library game's folder and title: a Mac build of it goes there once. */
  libraryGame?: { dir: string; title: string };
}

/** Make the archives, then install what a fresh profile starts with. */
export async function prepareNativeGamesFixture(deps: NativeGamesFixtureDeps): Promise<void> {
  const cache = path.join(deps.dir, ".program");
  await prepareFixtureArchives(
    deps.dir,
    deps.games,
    {
      buildApp: (spec, into) =>
        buildFixtureApp(
          {
            title: spec.title,
            bundleId: `games.genex.fixture.${spec.slug}`,
            hue: spec.hue,
            version: spec.version,
            arch: "universal",
            data: { name: LEVEL_FILE, bytes: spec.level },
          },
          into,
          cache,
        ),
      zip: async (app, zip) => {
        const zipped = await runTool("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, zip], {
          timeoutMs: ZIP_TIMEOUT_MS,
        });
        if (zipped.code !== 0) throw new Error(`ditto: ${zipped.stderr}`);
      },
      diskBytes,
    },
    [{ slug: "puck-rush", build: PUCK_RUSH_BEFORE }],
  );
  await installAtStart(deps);
  await buildLibraryGame(deps, cache);
}

/** A Mac build of the library's own game in its folder, once: Publish then lists a ready Mac app. */
async function buildLibraryGame(deps: NativeGamesFixtureDeps, cache: string): Promise<void> {
  const game = deps.libraryGame;
  if (!game) return;
  const into = path.join(game.dir, LIBRARY_BUILD);
  if (existsSync(into)) return;
  await buildFixtureApp(
    { title: game.title, bundleId: "games.genex.fixture.library", hue: 200, version: "1.0", arch: "universal" },
    into,
    cache,
  );
}

/**
 * Install Frigate and the older Puck Rush in a fresh profile, once: a reused profile keeps what the
 * person installed or removed since (a marker in the fixture's folder says it was done).
 */
async function installAtStart(deps: NativeGamesFixtureDeps): Promise<void> {
  const marker = path.join(deps.dir, SEEDED);
  if (existsSync(marker)) return;
  const before = async (slug: string): Promise<PlayGameDetail> => {
    const page = await deps.page(slug);
    if (slug !== "puck-rush" || !page.native) return page;
    const builds = parseNativeBuilds([fixtureBuildRow(slug, PUCK_RUSH_BEFORE)], buildHostsFor(true));
    return { ...page, native: { ...page.native, builds } };
  };
  const installer = nativeInstalls({
    root: deps.root,
    host: deps.host,
    hosts: buildHostsFor(true),
    game: before,
    fetch: fixtureNativeFetch,
    run: runTool,
    now: Date.now,
    publish: () => undefined,
  });
  for (const slug of [...INSTALLED_AT_START, "puck-rush"]) {
    if (await installer.record(slug)) continue;
    await installer.install(slug);
    await installer.idle();
  }
  await writeFile(marker, new Date().toISOString());
}
