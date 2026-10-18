/**
 * The showcase scenes' fetched assets: CC0 textures and sky maps from the pinned official URLs in
 * each scene's manifest (the lakeside's `native/genex-rust/examples/showcase/assets-manifest.json`,
 * Harbour Street's `native/genex-rust/examples/showcase/harbour/assets-manifest.json`), each
 * verified by its sha256.
 *
 *   node scripts/showcase-assets.ts fetch [--scene lakeside|harbour-street] [--pin] [--install]
 *
 * - `--scene` picks the scene (the lakeside by default). Every file downloads into
 *   `.studio-dev/assets-cache/<scene>/raw/<asset id>/<name>` (a file already there with the
 *   pinned sha256 is kept). A download is written beside its name and renamed into place only
 *   when its size and sha256 match the manifest; anything else is deleted and refused, so the
 *   cache never holds an unverified byte.
 * - `--pin` records the sha256 of a file the manifest has none for yet (a new asset's first fetch,
 *   reviewed in the manifest's diff). Without it an unpinned file is refused.
 * - Then `showcase-assets fetched` (the showcase crate's processing tool, through the cargo env
 *   helper) packs each terrain layer's two files where the manifest has terrain layers and copies the
 *   material maps and the sky maps into `.studio-dev/assets-cache/<scene>/assets/fetched/`, which
 *   the workspace's scene reads. `--install` also copies them into the scene's game folder
 *   (`assets/fetched/`, ignored by Git) for a Studio run.
 *
 * The fetch rules (https on an allowlisted CC0 host, CC0 only, plain names, size and sha256, the
 * rename into place) are `src/substrate/cc0-fetch.ts`'s; a refusal is one line on stderr, `genex-showcase-assets-refusal: {"code":…,"detail":…}`, and exit 78. No
 * scene depends on these files: without them it draws its procedural fallback.
 */
import { spawnSync } from "node:child_process";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Cc0Error,
  Cc0Refusal,
  cachedPath,
  checkManifest,
  fetchFile,
  httpsDownload,
  type Manifest,
} from "../src/substrate/cc0-fetch.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SHOWCASE = path.join(REPO, "native", "genex-rust", "examples", "showcase");
const CACHE_ROOT = path.join(REPO, ".studio-dev", "assets-cache");
const RUST_ENV = path.join(REPO, "scripts", "toolchains", "rust-env.ts");

/** The scenes with fetched assets. Wire values: `--scene` takes them and the cache is named by them. */
export const ShowcaseScene = {
  Lakeside: "lakeside",
  HarbourStreet: "harbour-street",
} as const;
export type ShowcaseScene = (typeof ShowcaseScene)[keyof typeof ShowcaseScene];

/** Where a scene's fetch reads and writes. */
export type SceneFolders = {
  /** The manifest the fetch reads (and `--pin` writes). */
  manifest: string;
  /** The local cache: `raw/` (verified downloads) and `assets/fetched/` (what the scene reads). */
  cache: string;
  /** The game folder's ignored copy `--install` writes for a Studio run. */
  installed: string;
};

/** Each scene's manifest, cache and installed copy. */
export const SCENES: Readonly<Record<ShowcaseScene, SceneFolders>> = {
  [ShowcaseScene.Lakeside]: {
    manifest: path.join(SHOWCASE, "assets-manifest.json"),
    cache: path.join(CACHE_ROOT, ShowcaseScene.Lakeside),
    installed: path.join(SHOWCASE, "game", "assets", "fetched"),
  },
  [ShowcaseScene.HarbourStreet]: {
    manifest: path.join(SHOWCASE, "harbour", "assets-manifest.json"),
    cache: path.join(CACHE_ROOT, ShowcaseScene.HarbourStreet),
    installed: path.join(SHOWCASE, "harbour", "assets", "fetched"),
  },
};
const REFUSAL_PREFIX = "genex-showcase-assets-refusal: ";
const REFUSAL_EXIT = 78;
/** The name every download sends (Poly Haven's API terms ask each client to name its software). */
const USER_AGENT = "genex-showcase-assets";

export {
  ALLOWED_HOSTS,
  CC0,
  Cc0Error as AssetError,
  cachedPath,
  checkedUrl,
  checkManifest,
  fetchFile,
  type Manifest,
  type ManifestAsset,
  type ManifestFile,
  sha256,
  verified,
} from "../src/substrate/cc0-fetch.ts";

/** Why the fetch refused: the CC0 fetch's refusals plus the command's own. Wire values: tests match them. */
export const AssetRefusal = {
  Usage: "usage",
  ...Cc0Refusal,
  ProcessFailed: "process-failed",
} as const;
export type AssetRefusal = (typeof AssetRefusal)[keyof typeof AssetRefusal];

function download(url: URL, maxBytes: number): Promise<Uint8Array> {
  return httpsDownload(url, maxBytes, USER_AGENT);
}

function processFetched(raw: string, out: string, manifest: string): void {
  const args = [
    "--",
    "cargo",
    "run",
    "-p",
    "showcase",
    "--release",
    "--offline",
    "--locked",
    "--bin",
    "showcase-assets",
  ];
  const run = spawnSync(process.execPath, [RUST_ENV, ...args, "--", "fetched", raw, out, manifest], {
    cwd: REPO,
    stdio: "inherit",
  });
  if (run.status !== 0) {
    throw new Cc0Error(AssetRefusal.ProcessFailed, `showcase-assets fetched exited ${run.status}`);
  }
}

/** What `fetch` was asked for. */
export type FetchOptions = { scene: ShowcaseScene; pin: boolean; install: boolean };

const USAGE = "node scripts/showcase-assets.ts fetch [--scene lakeside|harbour-street] [--pin] [--install]";
const SCENE_FLAG = "--scene";

function isScene(value: string | undefined): value is ShowcaseScene {
  return Object.values(ShowcaseScene).some((scene) => scene === value);
}

/** The command line `argv` (after the script) as options, or a usage refusal. */
export function parseArgs(argv: readonly string[]): FetchOptions {
  const [command, ...flags] = argv;
  if (command !== "fetch") {
    throw new Cc0Error(AssetRefusal.Usage, USAGE);
  }
  const options: FetchOptions = { scene: ShowcaseScene.Lakeside, pin: false, install: false };
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag === "--pin" || flag === "--install") {
      options[flag === "--pin" ? "pin" : "install"] = true;
      continue;
    }
    const scene = flags[index + 1];
    if (flag !== SCENE_FLAG || !isScene(scene)) {
      throw new Cc0Error(AssetRefusal.Usage, USAGE);
    }
    options.scene = scene;
    index += 1;
  }
  return options;
}

async function fetchAll(options: FetchOptions): Promise<void> {
  const folders = SCENES[options.scene];
  const manifest = JSON.parse(await readFile(folders.manifest, "utf8")) as Manifest;
  checkManifest(manifest);
  const raw = path.join(folders.cache, "raw");
  const before = JSON.stringify(manifest);
  for (const asset of manifest.assets) {
    for (const file of asset.files) {
      await fetchFile(file, cachedPath(raw, asset, file), options.pin, download);
      process.stdout.write(`${asset.id}/${file.name}: ${file.sha256}\n`);
    }
  }
  if (JSON.stringify(manifest) !== before) {
    await writeFile(folders.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  const out = path.join(folders.cache, "assets");
  processFetched(raw, out, folders.manifest);
  if (options.install) {
    await rm(folders.installed, { recursive: true, force: true });
    await cp(path.join(out, "fetched"), folders.installed, { recursive: true });
  }
}

async function main(argv: string[]): Promise<void> {
  await fetchAll(parseArgs(argv));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const code = error instanceof Cc0Error ? error.code : AssetRefusal.DownloadFailed;
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${REFUSAL_PREFIX}${JSON.stringify({ code, detail })}\n`);
    process.exit(REFUSAL_EXIT);
  });
}
