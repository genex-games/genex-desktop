/**
 * The native builds of a fixture launch's made-up games, as genex.games would serve their rows. Each
 * build's archive is on the fixture's `.invalid` build host, which never resolves: a fixture launch
 * never reaches the network for them.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { SECOND_MS } from "../../shared/duration.ts";
import { FIXTURE_BUILD_HOST, NativeArch, NativePlatform } from "../../shared/play-native.ts";

/** One build a fixture game has. */
export interface FixtureBuildSpec {
  platform: NativePlatform;
  arch: NativeArch;
  version: string;
  /** What runs, inside the archive. */
  entry: string;
  /** The archive's and the unpacked game's sizes, as the catalog states them. */
  sizeBytes: number;
  installedBytes: number;
  /** Its oldest macOS or Windows version. */
  minOs?: string;
  publishedAt: string;
}

/** A fixture game's native side. */
export interface FixtureNative {
  /** It has a web build too: its card plays that. */
  web: boolean;
  engine: string;
  builds: FixtureBuildSpec[];
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/** A Mac app of `title` at `version`, built for both kinds of Mac. */
export const macApp = (
  title: string,
  version: string,
  sizes: { archive: number; unpacked: number },
): FixtureBuildSpec => ({
  platform: NativePlatform.Mac,
  arch: NativeArch.Universal,
  version,
  entry: `${title}.app`,
  sizeBytes: sizes.archive,
  installedBytes: sizes.unpacked,
  minOs: "13.0",
  publishedAt: "2026-10-18T09:00:00.000Z",
});

/** A Windows program of `title` at `version`, in a folder of its own. */
export const windowsApp = (
  title: string,
  version: string,
  sizes: { archive: number; unpacked: number },
): FixtureBuildSpec => ({
  platform: NativePlatform.Windows,
  arch: NativeArch.X64,
  version,
  entry: `${title}/${title.replace(/\s+/g, "")}.exe`,
  sizeBytes: sizes.archive,
  installedBytes: sizes.unpacked,
  minOs: "10.0.19041",
  publishedAt: "2026-10-18T09:00:00.000Z",
});

/** Sizes the canvas shows: a 1.4 GB game, its 1.2 GB download. */
export const LARGE = { archive: Math.round(1.2 * GB), unpacked: Math.round(1.4 * GB) };
export const MEDIUM = { archive: 900 * MB, unpacked: Math.round(1.1 * GB) };
export const SMALL = { archive: 310 * MB, unpacked: 420 * MB };

/** Where a fixture build's archive is: the fixture build host, never a real one. */
export const fixtureBuildUrl = (slug: string, build: FixtureBuildSpec): string =>
  `https://${FIXTURE_BUILD_HOST}/${slug}/${build.version}/${build.platform}-${build.arch}.zip`;

/** A fixture archive made for this launch: its file and what the catalog says of it. */
interface FixtureArchive {
  file: string;
  sizeBytes: number;
  installedBytes: number;
  sha256: string;
}

/** The archives this launch made, by address (`prepareFixtureArchives`); none outside the native-games fixture. */
const archives = new Map<string, FixtureArchive>();

/**
 * A fixture build's row as genex.games serves it: the real facts of its archive once this launch
 * made one, else the catalog's stated sizes and a stand-in checksum (its install then fails as a
 * checksum, as it should: there is nothing to download).
 */
export function fixtureBuildRow(slug: string, build: FixtureBuildSpec): Record<string, unknown> {
  const url = fixtureBuildUrl(slug, build);
  const made = archives.get(url);
  if (made) {
    const { sizeBytes, installedBytes, sha256 } = made;
    return { ...build, url, sizeBytes, installedBytes, sha256 };
  }
  return { ...build, url, sha256: createHash("sha256").update(url).digest("hex") };
}

/** A fixture game's native fields on its gallery item: its builds, whether it has a web build and its engine. */
export const fixtureNativeFields = (slug: string, native: FixtureNative): Record<string, unknown> => ({
  builds: native.builds.map((build) => fixtureBuildRow(slug, build)),
  web: native.web,
  engine: native.engine,
});

/** A fixture game with native builds, as the fixture catalog lists it. */
export interface FixtureNativeGame {
  slug: string;
  title: string;
  hue: number;
  native: FixtureNative;
}

/** How large each made archive is: its stated size scaled down, so a download takes a few seconds. */
const ARCHIVE_SCALE = 1 / 64;
/** How fast the fixture's build host sends, so an install is seen downloading. */
const FIXTURE_BYTES_PER_SECOND = 4 * MB;
const FIXTURE_CHUNK_BYTES = 256 * 1024;

/** `bytes` of noise from a fixed seed: the same archive, and checksum, on every launch. */
function noise(bytes: number, seed: number): Buffer {
  const out = Buffer.alloc(bytes);
  let state = seed >>> 0 || 1;
  for (let at = 0; at + 4 <= bytes; at += 4) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out.writeUInt32LE(state >>> 0, at);
  }
  return out;
}

/** The deps that make and pack the stand-in apps; dev code passes the real ones. */
export interface FixtureArchiveDeps {
  /** Build `title`'s app at `version` into `dir`, carrying `level` as its data, and answer its path. */
  buildApp(
    spec: { title: string; slug: string; hue: number; version: string; level: Uint8Array },
    dir: string,
  ): Promise<string>;
  /** Zip `app` into `zip` as a release does (`ditto -c -k --keepParent`). */
  zip(app: string, zip: string): Promise<void>;
  /** The space a folder takes on disk. */
  diskBytes(dir: string): Promise<number>;
}

/**
 * Make each fixture game's Mac archive in `dir` (kept there, so a reused profile serves the same
 * bytes) and register it, so the catalog states its real size and checksum and the fixture host
 * serves it. `extra` adds versions the catalog no longer offers (an older one to update from).
 */
export async function prepareFixtureArchives(
  dir: string,
  games: readonly FixtureNativeGame[],
  deps: FixtureArchiveDeps,
  extra: ReadonlyArray<{ slug: string; build: FixtureBuildSpec }> = [],
): Promise<void> {
  const wanted = [
    ...games.flatMap((game) => game.native.builds.map((build) => ({ slug: game.slug, build }))),
    ...extra,
  ].filter(({ build }) => build.platform === NativePlatform.Mac);
  for (const { slug, build } of wanted) {
    const game = games.find((one) => one.slug === slug);
    const title = game?.title ?? slug;
    const zip = path.join(dir, slug, `${build.version}.zip`);
    const unpacked = path.join(dir, slug, build.version);
    if (!existsSync(zip)) {
      await mkdir(unpacked, { recursive: true });
      const size = Math.round(build.sizeBytes * ARCHIVE_SCALE);
      const level = noise(size, size);
      const app = await deps.buildApp({ title, slug, hue: game?.hue ?? 210, version: build.version, level }, unpacked);
      await deps.zip(app, zip);
    }
    const data = await readFile(zip);
    archives.set(fixtureBuildUrl(slug, build), {
      file: zip,
      sizeBytes: data.length,
      installedBytes: Math.max(data.length, await deps.diskBytes(unpacked)),
      sha256: createHash("sha256").update(data).digest("hex"),
    });
  }
}

/** The bytes of `data` from `start`, sent at the fixture host's pace; it errors once `signal` stops. */
function pacedBody(data: Buffer, start: number, signal: AbortSignal | null | undefined): ReadableStream<Uint8Array> {
  let at = start;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (signal?.aborted) return controller.error(signal.reason);
      if (at >= data.length) return controller.close();
      await sleep((FIXTURE_CHUNK_BYTES / FIXTURE_BYTES_PER_SECOND) * SECOND_MS);
      const end = Math.min(data.length, at + FIXTURE_CHUNK_BYTES);
      controller.enqueue(data.subarray(at, end));
      at = end;
    },
  });
}

/**
 * The fixture build host: a fetch that answers only the archives this launch made, from their
 * files, honouring a range, and refuses everything else. It never opens a socket.
 */
export const fixtureNativeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const made = archives.get(url);
  init?.signal?.throwIfAborted();
  if (!made) return new Response(null, { status: 404 });
  const data = await readFile(made.file);
  const range = /^bytes=(\d+)-$/.exec(new Headers(init?.headers).get("range") ?? "");
  const start = range ? Number(range[1]) : 0;
  if (start >= data.length) return new Response(null, { status: 416 });
  const headers: Record<string, string> = { "content-length": String(data.length - start) };
  if (range) headers["content-range"] = `bytes ${start}-${data.length - 1}/${data.length}`;
  return new Response(pacedBody(data, start, init?.signal), { status: range ? 206 : 200, headers });
}) as typeof fetch;
