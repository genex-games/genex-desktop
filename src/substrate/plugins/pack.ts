import path from "node:path";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import type { PluginCategory, PluginIndexEntry, PluginManifest, PluginTier } from "../../shared/plugins.ts";
import { assertRelativePath } from "../paths.ts";
import { inspectPackage } from "./manifest.ts";

/** The publisher `plugin:new` writes until the author names themselves; never a catalog owner. */
export const SCAFFOLD_PUBLISHER = "Unpublished";

/** The largest artifact envelope Studio downloads and the catalog accepts. */
export const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;

/**
 * Authoring-only files the scaffold puts at a package's root (`plugin:new`): type checks and the
 * coding agent's notes for the author, never read by Studio at run time.
 */
const AUTHORING_ONLY = new Set(["jsconfig.json", "tsconfig.json", "plugin-sdk", "AGENTS.md"]);

const MESSAGE = {
  Unpackable: (rel: string) => `Unsupported package file: ${rel} (links and special files cannot be packed)`,
  TooLarge: "Artifact exceeds 256 MiB",
  InvalidEnvelope: "Invalid artifact: expected a JSON object of relative file names to base64 contents",
  InvalidEnvelopeFile: (rel: string) => `Invalid artifact file: ${rel}`,
} as const;

/**
 * Whether `name`, in the package folder `relative` ("" at the root), is part of the package.
 * Dotfiles and dot-folders anywhere (`.git`, `.env`) and the scaffold's authoring files at the root
 * never are: packing leaves them out, installing does not copy them and the scan does not read
 * them, so what an author checks, what a user installs and what the catalog ships are one set.
 */
export const isPackageEntry = (name: string, relative: string): boolean =>
  !name.startsWith(".") && !(relative === "" && AUTHORING_ONLY.has(name));

/** Whether a `/`-separated package-relative path is part of the package: every segment of it is. */
export function isPackagePath(file: string): boolean {
  const parts = file.split("/");
  return parts.every((part, i) => isPackageEntry(part, parts.slice(0, i).join("/")));
}

/** A `cp` filter that copies a package folder's own entries only ({@link isPackageEntry}). */
export function packageCopyFilter(root: string): (source: string) => boolean {
  return (source) => {
    const relative = path.relative(root, source);
    return relative === "" || isPackagePath(relative.split(path.sep).join("/"));
  };
}

/**
 * The files of a prebuilt package as an artifact envelope ({relative path: base64}). Dotfiles and
 * dot-folders (`.git`, `.env`, caches) and the scaffold's editor files stay out; a link or special
 * file is refused rather than followed, so nothing outside the folder can end up in the artifact.
 */
export async function packageFiles(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  await packFolder(root, "", files);
  return files;
}

/** Add every packable file under `relative` to `files`, in name order. */
async function packFolder(root: string, relative: string, files: Record<string, string>): Promise<void> {
  for (const name of (await readdir(path.join(root, relative))).sort()) {
    if (!isPackageEntry(name, relative)) continue;
    await packEntry(root, relative ? `${relative}/${name}` : name, files);
  }
}

/** A folder is walked, a regular file is read, and a link or special file is refused. */
async function packEntry(root: string, rel: string, files: Record<string, string>): Promise<void> {
  const info = await lstat(path.join(root, rel));
  const packable = !info.isSymbolicLink() && (info.isFile() || info.isDirectory());
  if (!packable) throw new Error(MESSAGE.Unpackable(rel));
  if (info.isDirectory()) await packFolder(root, rel, files);
  else files[rel] = (await readFile(path.join(root, rel))).toString("base64");
}

/** A packed release: the manifest it carries, its envelope bytes and their sha-256. */
export interface PackedPlugin {
  manifest: PluginManifest;
  bytes: Buffer;
  sha256: string;
}

/** Pack a prebuilt package after the same inspection the installer runs; nothing in it is executed. */
export async function packEnvelope(root: string): Promise<PackedPlugin> {
  const manifest = await inspectPackage(root);
  const bytes = Buffer.from(JSON.stringify(await packageFiles(root)));
  if (bytes.length > MAX_ARTIFACT_BYTES) throw new Error(MESSAGE.TooLarge);
  return { manifest, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** What a catalog listing adds to a package's own manifest: where its source is and how it is filed. */
export interface CatalogSource {
  category: PluginCategory;
  tier: PluginTier;
  /** owner/repo */
  repo: string;
  /** 40-hex source commit */
  sha: string;
  subdir?: string;
  docsUrl?: string;
  minStudioVersion?: string;
}

/** The catalog entry (and immutable release record) for a packed release hosted under `artifactBaseUrl`. */
export function catalogEntry(packed: PackedPlugin, source: CatalogSource, artifactBaseUrl: string): PluginIndexEntry {
  const { manifest, sha256 } = packed;
  const base = artifactBaseUrl.replace(/\/$/, "");
  const entry: PluginIndexEntry = {
    id: manifest.id,
    name: manifest.name,
    publisher: manifest.publisher,
    description: manifest.description,
    category: source.category,
    tier: source.tier,
    repo: source.repo,
    sha: source.sha,
    version: manifest.version,
    capabilities: [...manifest.capabilities],
    artifact: { url: `${base}/${manifest.id}/${manifest.version}/${sha256}.json`, sha256 },
  };
  if (source.subdir) entry.subdir = source.subdir;
  if (source.docsUrl) entry.docsUrl = source.docsUrl;
  if (source.minStudioVersion) entry.minStudioVersion = source.minStudioVersion;
  return entry;
}

/** An envelope's files, every name checked and every value decoded before any of them is written. */
function envelopeFiles(bytes: Buffer): Array<[string, Buffer]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(MESSAGE.InvalidEnvelope);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(MESSAGE.InvalidEnvelope);
  return Object.entries(parsed).map(([file, base64]): [string, Buffer] => {
    assertRelativePath(file);
    if (typeof base64 !== "string") throw new Error(MESSAGE.InvalidEnvelopeFile(file));
    return [file, Buffer.from(base64, "base64")];
  });
}

/**
 * Write an artifact envelope's files into `directory`, which the caller made and which is empty.
 * Prebuilt files, not an archive: no links, no hooks, and a name that would leave the folder (or
 * collide with one already written) refuses the whole envelope. Returns the names written.
 */
export async function unpackEnvelope(bytes: Buffer, directory: string): Promise<string[]> {
  const files = envelopeFiles(bytes);
  for (const [file, data] of files) {
    const destination = path.join(directory, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, data, { flag: "wx" });
  }
  return files.map(([file]) => file);
}
