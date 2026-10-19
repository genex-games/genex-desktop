/**
 * The asset importer's tools (`src/substrate/asset-import/decoders.ts`): the Basis Universal v2.50
 * build, Draco's glTF decoder and meshoptimizer's modules, every file held to its pin.
 *
 *   node scripts/toolchains/importer-tools.ts fetch          the Basis build into .studio-dev/tools/
 *   node scripts/toolchains/importer-tools.ts stage <dir>    every tool file into <dir>/<folder>/
 *   node scripts/toolchains/importer-tools.ts verify <dir>   a staged or packaged copy, every file
 *
 * `fetch` downloads the two Basis files from the release commit `BASIS_ENCODER` names
 * (`src/substrate/asset-import/basis-encoder.ts`) into `.studio-dev/tools/basis-encoder-<version>/`
 * (ignored by Git), each held to its size and sha256 before it is kept; a file already there with
 * the pinned sha256 is kept. A download is written beside its name and renamed into place only
 * when it matches. The npm tools come from `npm ci` (`draco3dgltf`, `meshoptimizer`).
 *
 * The build stages the tools into `dist/resources/importer-tools/` ({@link bundleImporterTools}),
 * which the packaged app carries unpacked beside the other resources (forge.config.cjs unpacks
 * `dist/resources/**`); the importer reads them there through `GENEX_IMPORTER_TOOLS`. A release
 * build fetches the Basis build when the checkout lacks it and fails closed when any file is
 * missing or differs from its pin; a development build warns and stages the rest. A refusal is one
 * line on stderr,
 * `genex-importer-tools-refusal: {"code":…,"detail":…}`, and exit 78.
 */
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BASIS_ENCODER } from "../../src/substrate/asset-import/basis-encoder.ts";
import {
  devToolFolder,
  IMPORTER_TOOL_FILES,
  IMPORTER_TOOL_PACKAGES,
  IMPORTER_TOOLS_RESOURCES_FOLDER,
  ImporterToolFolder,
} from "../../src/substrate/asset-import/decoders.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
/** Where `fetch` keeps the Basis build (what a development checkout's importer and tests read). */
export const BASIS_DIR = devToolFolder(ImporterToolFolder.Basis, REPO);
/** The folder the build stages the tools into, under the app's resources (`decoders.ts` owns it). */
export { IMPORTER_TOOLS_RESOURCES_FOLDER };
/** The notices page staged beside the tools: it holds their licence texts. */
const NOTICES = "THIRD-PARTY-NOTICES.md";
const REFUSAL_PREFIX = "genex-importer-tools-refusal: ";
const REFUSAL_EXIT = 78;

/** Why the tools were refused. Wire values: never rename one. */
export const ImporterToolsRefusal = {
  Usage: "usage",
  DownloadFailed: "download-failed",
  SizeMismatch: "size-mismatch",
  HashMismatch: "hash-mismatch",
  /** A pinned file is not there, or is not a regular file (a link, a folder). */
  Missing: "missing",
  /** An npm tool's package is not at its pinned version. */
  VersionMismatch: "version-mismatch",
} as const;
export type ImporterToolsRefusal = (typeof ImporterToolsRefusal)[keyof typeof ImporterToolsRefusal];

/** A refused tool file, typed. */
export class ImporterToolsError extends Error {
  readonly code: ImporterToolsRefusal;
  constructor(code: ImporterToolsRefusal, detail: string) {
    super(detail);
    this.name = "ImporterToolsError";
    this.code = code;
  }
}

const MESSAGE = {
  skipped: (problems: readonly ImporterToolsError[]) =>
    `importer-tools: not staged (${problems.map((problem) => `${problem.code}: ${problem.message}`).join("; ")}). This build's importer cannot run those tools; run node scripts/toolchains/importer-tools.ts fetch.`,
};

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The bytes of a regular file, never through a link; null when there is none. */
async function regularFile(file: string): Promise<Uint8Array | null> {
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile()) return null;
  return new Uint8Array(await readFile(file));
}

/** `bytes`, refused unless they are the pinned file `name`. */
function holdToPin(name: string, bytes: Uint8Array | null): Uint8Array {
  const pin = IMPORTER_TOOL_FILES[name];
  if (!pin) throw new ImporterToolsError(ImporterToolsRefusal.Missing, `${name}: no pin`);
  if (!bytes) throw new ImporterToolsError(ImporterToolsRefusal.Missing, name);
  if (bytes.byteLength !== pin.bytes)
    throw new ImporterToolsError(ImporterToolsRefusal.SizeMismatch, `${name}: ${bytes.byteLength} bytes`);
  if (sha256(bytes) !== pin.sha256)
    throw new ImporterToolsError(ImporterToolsRefusal.HashMismatch, `${name}: ${sha256(bytes)}`);
  return bytes;
}

/** One pinned Basis file in place: kept when it already matches, else downloaded and checked. */
async function fetchBasisFile(dir: string, file: (typeof BASIS_ENCODER.files)[number]): Promise<void> {
  const target = path.join(dir, file.name);
  const held = await readFile(target).catch(() => null);
  if (held && sha256(held) === file.sha256) return;
  const response = await fetch(`${BASIS_ENCODER.source}${file.name}`).catch(() => null);
  if (!response?.ok)
    throw new ImporterToolsError(
      ImporterToolsRefusal.DownloadFailed,
      `${file.name}: ${response?.status ?? "no answer"}`,
    );
  const bytes = holdToPin(`${ImporterToolFolder.Basis}/${file.name}`, new Uint8Array(await response.arrayBuffer()));
  const partial = `${target}.partial`;
  await writeFile(partial, bytes);
  await rename(partial, target);
}

/** Fetch the Basis build's two files into `dir` (the development checkout's own by default). */
export async function fetchBasis(dir = BASIS_DIR): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const file of BASIS_ENCODER.files) {
    try {
      await fetchBasisFile(dir, file);
    } catch (error) {
      await rm(`${path.join(dir, file.name)}.partial`, { force: true });
      throw error;
    }
  }
}

/** The npm package an npm tool folder is read from must be at its pinned version. */
async function checkPackageVersion(folder: ImporterToolFolder, repo: string): Promise<void> {
  if (folder === ImporterToolFolder.Basis) return;
  const { name, version } = IMPORTER_TOOL_PACKAGES[folder];
  const manifest = await regularFile(path.join(devToolFolder(folder, repo), "package.json"));
  const found = manifest ? (JSON.parse(new TextDecoder().decode(manifest)) as { version?: unknown }).version : null;
  if (found !== version)
    throw new ImporterToolsError(ImporterToolsRefusal.VersionMismatch, `${name}: ${String(found)}, pinned ${version}`);
}

/** Every pinned file name (`<folder>/<file>`), in a stable order. */
const pinnedNames = () => Object.keys(IMPORTER_TOOL_FILES).sort();

/** What staging did: the files written, and each one refused (nothing is written for those). */
export interface StagedTools {
  staged: string[];
  refused: ImporterToolsError[];
}

/**
 * Every pinned tool file from a development checkout (`repo`: its `node_modules` and its fetched
 * Basis build) into `dest/<folder>/<file>`, held to its pin first, and the notices page beside
 * them. `dest`'s tool folders are replaced; a file that is refused is not written.
 */
export async function stageImporterTools(repo: string, dest: string): Promise<StagedTools> {
  for (const folder of Object.values(ImporterToolFolder))
    await rm(path.join(dest, folder), { recursive: true, force: true });
  const versions = new Map<ImporterToolFolder, ImporterToolsError | null>();
  for (const folder of Object.values(ImporterToolFolder)) {
    versions.set(
      folder,
      await checkPackageVersion(folder, repo).then(
        () => null,
        (error: ImporterToolsError) => error,
      ),
    );
  }
  const result: StagedTools = { staged: [], refused: [] };
  for (const name of pinnedNames()) {
    const [folder, ...rest] = name.split("/");
    const known = Object.values(ImporterToolFolder).find((value) => value === folder);
    if (!known) continue;
    const versionError = versions.get(known);
    try {
      if (versionError) throw versionError;
      const bytes = holdToPin(name, await regularFile(path.join(devToolFolder(known, repo), ...rest)));
      await mkdir(path.join(dest, known), { recursive: true });
      await writeFile(path.join(dest, name), bytes, { flag: "wx" });
      result.staged.push(name);
    } catch (error) {
      if (!(error instanceof ImporterToolsError)) throw error;
      if (!result.refused.includes(error)) result.refused.push(error);
    }
  }
  await copyFile(path.join(repo, NOTICES), path.join(dest, NOTICES));
  return result;
}

/** Throws {@link ImporterToolsError} for the first file of a staged or packaged copy that is missing or not its pin. */
export async function verifyImporterTools(dir: string): Promise<void> {
  for (const name of pinnedNames()) holdToPin(name, await regularFile(path.join(dir, name)));
  if (!(await regularFile(path.join(dir, NOTICES))))
    throw new ImporterToolsError(ImporterToolsRefusal.Missing, NOTICES);
}

/** What the build's step reaches: injected. */
export interface BundleImporterToolsOptions {
  /** The checkout the tools are read from. */
  root: string;
  /** The app's resources folder; the tools go into its `importer-tools/`. */
  resources: string;
  release: boolean;
  warn?: (message: string) => void;
  /** How a release build gets the Basis build when the checkout has not fetched it ({@link fetchBasis}). */
  fetchBasis?: (dir: string) => Promise<void>;
}

/**
 * The build's step: the tools into `<resources>/importer-tools/`. A release build first fetches
 * the pinned Basis build when the checkout lacks it, and fails closed, staging nothing, when any
 * file is refused; a development build fetches nothing, warns and keeps the rest.
 */
export async function bundleImporterTools(options: BundleImporterToolsOptions): Promise<StagedTools> {
  const dest = path.join(options.resources, IMPORTER_TOOLS_RESOURCES_FOLDER);
  await rm(dest, { recursive: true, force: true });
  if (options.release) await (options.fetchBasis ?? fetchBasis)(devToolFolder(ImporterToolFolder.Basis, options.root));
  const staged = await stageImporterTools(options.root, dest);
  if (staged.refused.length === 0) return staged;
  if (options.release) {
    await rm(dest, { recursive: true, force: true });
    const [first] = staged.refused;
    throw first ?? new ImporterToolsError(ImporterToolsRefusal.Missing, dest);
  }
  (options.warn ?? console.warn)(MESSAGE.skipped(staged.refused));
  return staged;
}

/** Run one command line; answers what to print. */
async function main(argv: readonly string[]): Promise<string> {
  const [command, dir] = argv;
  if (command === "fetch" && !dir) {
    await fetchBasis();
    return BASIS_DIR;
  }
  if (command === "stage" && dir) {
    const { refused } = await stageImporterTools(REPO, path.resolve(dir));
    const [first] = refused;
    if (first) throw first;
    return path.resolve(dir);
  }
  if (command === "verify" && dir) {
    await verifyImporterTools(path.resolve(dir));
    return path.resolve(dir);
  }
  throw new ImporterToolsError(
    ImporterToolsRefusal.Usage,
    "usage: importer-tools.ts fetch | stage <dir> | verify <dir>",
  );
}

if (import.meta.main) {
  try {
    process.stdout.write(`${await main(process.argv.slice(2))}\n`);
  } catch (error) {
    const code = error instanceof ImporterToolsError ? error.code : ImporterToolsRefusal.DownloadFailed;
    process.stderr.write(`${REFUSAL_PREFIX}${JSON.stringify({ code, detail: (error as Error).message })}\n`);
    process.exit(REFUSAL_EXIT);
  }
}
