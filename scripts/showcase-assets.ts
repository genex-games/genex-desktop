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
 * A manifest URL must be https on an allowlisted CC0 host and a file name a plain name; a refusal
 * is one line on stderr, `genex-showcase-assets-refusal: {"code":…,"detail":…}`, and exit 78. No
 * scene depends on these files: without them it draws its procedural fallback.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
/** The hosts a manifest URL may name: Poly Haven's and ambientCG's official download servers. */
export const ALLOWED_HOSTS: ReadonlySet<string> = new Set(["dl.polyhaven.org", "ambientcg.com"]);
/** The only licence a fetched asset may carry. */
export const CC0 = "CC0-1.0";
/** A plain file or folder name: no separators, no `.` or `..`, no leading dot. */
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Why the fetch refused. Wire values: tests match them. */
export const AssetRefusal = {
  Usage: "usage",
  ManifestInvalid: "manifest-invalid",
  HostNotAllowed: "host-not-allowed",
  NotCc0: "licence-not-cc0",
  UnsafeName: "unsafe-name",
  Unpinned: "unpinned",
  DownloadFailed: "download-failed",
  SizeMismatch: "size-mismatch",
  HashMismatch: "hash-mismatch",
  ProcessFailed: "process-failed",
} as const;
export type AssetRefusal = (typeof AssetRefusal)[keyof typeof AssetRefusal];

/** A refusal with its typed code. */
export class AssetError extends Error {
  readonly code: AssetRefusal;
  constructor(code: AssetRefusal, detail: string) {
    super(detail);
    this.code = code;
  }
}

/** One file of an asset: a map of a texture set, or the sky map. */
export type ManifestFile = { map: string; name: string; url: string; bytes: number; sha256: string | null };
/** One fetched asset. */
export type ManifestAsset = { id: string; kind: string; licence: string; files: ManifestFile[] };
/** The manifest (only the fields the fetch reads are typed). */
export type Manifest = { assets: ManifestAsset[] };

/** `url` if it is https on an allowlisted host, else a refusal. */
export function checkedUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AssetError(AssetRefusal.ManifestInvalid, `not a URL: ${url}`);
  }
  const plainHttps =
    parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" && parsed.port === "";
  if (!plainHttps || !ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new AssetError(AssetRefusal.HostNotAllowed, url);
  }
  return parsed;
}

function checkedName(name: string): string {
  if (!PLAIN_NAME.test(name) || name.includes("..")) {
    throw new AssetError(AssetRefusal.UnsafeName, name);
  }
  return name;
}

function checkFile(file: ManifestFile): void {
  checkedName(file.name);
  checkedUrl(file.url);
  const pinned = file.sha256 === null || SHA256_HEX.test(file.sha256);
  if (!Number.isSafeInteger(file.bytes) || file.bytes <= 0 || !pinned) {
    throw new AssetError(AssetRefusal.ManifestInvalid, `${file.name}: bytes or sha256`);
  }
}

/** Check every asset of `manifest` (names, hosts, licence, sizes, digests) before anything runs. */
export function checkManifest(manifest: Manifest): void {
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) {
    throw new AssetError(AssetRefusal.ManifestInvalid, "no assets");
  }
  for (const asset of manifest.assets) {
    checkedName(asset.id);
    if (asset.licence !== CC0) {
      throw new AssetError(AssetRefusal.NotCc0, `${asset.id}: ${asset.licence}`);
    }
    for (const file of asset.files) {
      checkFile(file);
    }
  }
}

/** The sha256 of `bytes`, lowercase hex. */
export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * `bytes` checked against `file`: its size, and its sha256 against the pin (or recorded into
 * `file` when `pin` allows and none is pinned yet). Answers the digest; a refusal otherwise.
 */
export function verified(file: ManifestFile, bytes: Uint8Array, pin: boolean): string {
  if (bytes.byteLength !== file.bytes) {
    throw new AssetError(AssetRefusal.SizeMismatch, `${file.name}: ${bytes.byteLength} bytes, manifest ${file.bytes}`);
  }
  const digest = sha256(bytes);
  if (file.sha256 === null && !pin) {
    throw new AssetError(AssetRefusal.Unpinned, `${file.name}: run with --pin to record ${digest}`);
  }
  if (file.sha256 !== null && file.sha256 !== digest) {
    throw new AssetError(AssetRefusal.HashMismatch, `${file.name}: ${digest}, pinned ${file.sha256}`);
  }
  return digest;
}

/** Where `file` of `asset` is cached under `raw`. */
export function cachedPath(raw: string, asset: ManifestAsset, file: ManifestFile): string {
  return path.join(raw, checkedName(asset.id), checkedName(file.name));
}

/** Whether `target` already holds `file`'s pinned bytes. */
async function alreadyCached(target: string, file: ManifestFile): Promise<boolean> {
  if (file.sha256 === null || !existsSync(target)) {
    return false;
  }
  return sha256(await readFile(target)) === file.sha256;
}

/** Download `file` into `target` (verified, written beside it, renamed into place). */
export async function fetchFile(
  file: ManifestFile,
  target: string,
  pin: boolean,
  download: (url: URL) => Promise<Uint8Array>,
): Promise<void> {
  if (await alreadyCached(target, file)) {
    return;
  }
  const bytes = await download(checkedUrl(file.url));
  file.sha256 = verified(file, bytes, pin);
  await mkdir(path.dirname(target), { recursive: true });
  const partial = `${target}.partial`;
  try {
    await writeFile(partial, bytes);
    await rename(partial, target);
  } finally {
    await rm(partial, { force: true });
  }
}

async function httpsDownload(url: URL): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: "error", headers: { "user-agent": "genex-showcase-assets" } });
  if (!response.ok) {
    throw new AssetError(AssetRefusal.DownloadFailed, `${url.href}: HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
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
    throw new AssetError(AssetRefusal.ProcessFailed, `showcase-assets fetched exited ${run.status}`);
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
    throw new AssetError(AssetRefusal.Usage, USAGE);
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
      throw new AssetError(AssetRefusal.Usage, USAGE);
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
      await fetchFile(file, cachedPath(raw, asset, file), options.pin, httpsDownload);
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
    const code = error instanceof AssetError ? error.code : AssetRefusal.DownloadFailed;
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${REFUSAL_PREFIX}${JSON.stringify({ code, detail })}\n`);
    process.exit(REFUSAL_EXIT);
  });
}
