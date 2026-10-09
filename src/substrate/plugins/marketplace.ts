import path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import type {
  GithubLookup,
  GithubPluginFound,
  GithubVersion,
  PluginIndex,
  PluginIndexEntry,
  PluginIndexView,
  PluginInfo,
  PluginManifest,
  PluginScan,
  PluginSource,
} from "../../shared/plugins.ts";
import {
  GithubLookupKind,
  GithubLookupProblem,
  GithubVersionKind,
  PLUGIN_CATEGORIES,
  PluginSourceKind,
  PluginTier,
} from "../../shared/plugins.ts";
import { type GithubLink, manifestFolder, parseGithubLink, pinnedSpec } from "../../shared/github-link.ts";
import { isPluginId } from "../../shared/plugin-id.ts";
import { atomicWriteJson } from "../fsx.ts";
import { inspectPackage, validateManifest } from "./manifest.ts";
import { assertRelativePath } from "../paths.ts";
import { scanPackage } from "./scan.ts";
import { isPackagePath, MAX_ARTIFACT_BYTES } from "./pack.ts";
import { errorMessage, UserCancelledError } from "../../shared/errors.ts";
import { HOUR_MS, MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";

/**
 * Curated index + sha-pinned GitHub installs. Cataloged is not audited: the index says where the code
 * is, the scan says what it appears to do, and the user still approves a trusted native backend.
 * Nothing is extracted from an archive and no install hook ever runs — every file is fetched as a blob,
 * checked against the commit's own object id and written through `assertRelativePath`.
 */
/** The one host the published catalog and its artifacts live on. */
const CATALOG_ORIGIN = "https://plugins.genex.games";
export const DEFAULT_INDEX_URL = `${CATALOG_ORIGIN}/catalog/v1/index.json`;
/** Where a reviewed release's artifact is uploaded: `<base>/<id>/<version>/<sha256>.json`. */
export const CATALOG_ARTIFACT_BASE_URL = `${CATALOG_ORIGIN}/releases`;
const INDEX_TTL_MS = 6 * HOUR_MS;
const INDEX_TIMEOUT_MS = 15 * SECOND_MS;
const INDEX_MAX_BYTES = 1024 * 1024;
// Bundled runtimes are much larger than index metadata; allow bounded slow-network delivery.
const ARTIFACT_TIMEOUT_MS = 5 * MINUTE_MS;
const TREE_MAX_FILES = 400;
const FILE_MAX_BYTES = 8 * 1024 * 1024;
const TREE_MAX_BYTES = 64 * 1024 * 1024;
/** How much of a commit sha a note shows. */
const PIN_PREVIEW_CHARS = 12;
/** How much of a commit sha a pasted link's version shows, as GitHub shows it. */
const SHORT_SHA_CHARS = 7;
/** How many plugins one repository lookup offers to choose from. */
const LOOKUP_MAX_PLUGINS = 12;
/** How many recent releases the version list offers. */
const VERSIONS_LISTED = 10;
/** How many folders deep a repository lookup looks for a plugin.json. */
const LOOKUP_MAX_DEPTH = 4;
/** GitHub's answers that mean the repository, branch or tag is not there (or not public). */
const NOT_THERE = new Set([404, 422]);
const GITHUB_HEADERS = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const VERSION = /^\d+\.\d+\.\d+$/;

/** What a person reads when the marketplace, a pinned commit or a download is refused. */
const MESSAGE = {
  LinksInPackage: "Plugin packages may not contain symlinks or submodules",
  FileMode: (mode: string | undefined, file: string) => `Unsupported file mode ${mode} in ${file}`,
  FileTooLarge: (relative: string) => `${relative} exceeds ${FILE_MAX_BYTES} bytes`,
  InvalidSpec: "Invalid plugin spec; use owner/repo[/subdir]@<40-character commit sha>",
  SpecNeedsSha: "Plugin spec needs a 40-character commit sha: owner/repo[/subdir]@<sha>",
  SpecNeedsRepo: "Plugin spec needs owner/repo before the sha",
  InvalidEntry: (id: string) => `Invalid marketplace entry ${id}`,
  InvalidCategory: (id: string) => `Invalid marketplace category for ${id}`,
  InvalidTier: (id: string) => `Invalid marketplace tier for ${id}`,
  InvalidRepo: (id: string) => `Invalid marketplace repo for ${id}`,
  InvalidSha: (id: string) => `Invalid marketplace sha for ${id}`,
  InvalidVersion: (id: string) => `Invalid marketplace version for ${id}`,
  InvalidCapabilities: (id: string) => `Invalid marketplace capabilities for ${id}`,
  InvalidMinStudioVersion: (id: string) => `Invalid minStudioVersion for ${id}`,
  InsecureLinks: (id: string) => `Marketplace links must be https (${id})`,
  InvalidArtifact: (id: string) => `Invalid marketplace artifact for ${id}`,
  InvalidIndex: "Invalid marketplace index",
  InvalidEntryId: "Invalid marketplace entry id",
  DuplicateEntry: (id: string) => `Duplicate marketplace entry ${id}`,
  InsecureIndexUrl: "marketplace.json indexUrl must be https",
  DownloadFailed: (what: string, status: number) => `${what} failed (${status})`,
  DownloadTooLarge: (what: string, cap: number) => `${what} exceeds ${cap} bytes`,
  NeedsNewerStudio: (name: string, minimum: string) => `${name} needs Studio ${minimum} or newer`,
  InvalidRepository: "Invalid repository",
  TreeTruncated: "Repository tree is truncated; point the spec at a smaller subdirectory",
  TreeUnreadable: "Repository tree is unreadable",
  PackageTooLarge: `Plugin package exceeds ${TREE_MAX_BYTES} bytes`,
  MissingObjectId: (relative: string) => `Missing object id for ${relative}`,
  TooManyFiles: `Plugin package exceeds ${TREE_MAX_FILES} files`,
  NoManifest: "No plugin.json at that path in the pinned commit",
  IntegrityFailed: (relative: string) =>
    `Integrity check failed for ${relative}: the file does not match the pinned commit`,
  OriginUnknown: "Studio does not know where this plugin came from; load it again",
  EntryMismatch: (mismatch: string) => `Marketplace entry does not match the plugin at that commit (${mismatch})`,
  NotInIndex: "Plugin is not in the marketplace index",
  DigestMismatch: "Plugin artifact digest mismatch",
  Unscanned: "Plugin artifact was installed without a scan",
  Offline: "Studio is offline in this profile",
  LookupDownload: "GitHub lookup",
  ReleaseUnreadable: "GitHub answered with a release Studio can’t read",
  CommitUnreadable: "GitHub answered with a commit Studio can’t read",
  RepositoryUnreadable: "GitHub answered with a repository Studio can’t read",
  ManifestNotJson: "plugin.json is not valid JSON",
  IndexDownload: "Marketplace index download",
  TreeDownload: "Repository tree download",
  FileDownload: (relative: string) => `${relative} download`,
  PluginDownload: "Plugin download",
  MovedPin: (short: string) =>
    `The marketplace now pins ${short}; this reinstalls the commit you approved. Use "Update to ${short}" to move to it.`,
} as const;

export interface GithubSpec {
  repo: string;
  owner: string;
  name: string;
  subdir?: string;
  sha: string;
}
export interface GithubBlob {
  path: string;
  relative: string;
  sha: string;
  size: number;
}
export interface StagedPackage {
  stage: string;
  manifest: PluginManifest;
  scan: PluginScan;
  origin: PluginSource;
}
export interface InstalledPackage {
  manifest: PluginManifest;
  scan: PluginScan;
  origin: PluginSource;
}
interface CachedIndex {
  url: string;
  fetchedAt: number;
  index: PluginIndex;
  rejected?: number;
}

/** Keep valid listings available while refusing each malformed entry independently. */
function readableIndex(value: unknown): { index: PluginIndex; rejected: number } {
  const raw = value as PluginIndex;
  if (!isIndexShape(raw)) throw new Error(MESSAGE.InvalidIndex);
  const plugins: PluginIndexEntry[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  for (const entry of raw.plugins) {
    try {
      const validated = validateIndex({ ...raw, plugins: [entry] }).plugins[0];
      if (!validated || seen.has(validated.id)) throw new Error(MESSAGE.InvalidEntryId);
      seen.add(validated.id);
      plugins.push(validated);
    } catch {
      rejected += 1;
    }
  }
  return { index: { version: INDEX_VERSION, updatedAt: raw.updatedAt, plugins }, rejected };
}
/** The slice of PluginRegistry the marketplace installs through; keeps this module free of registry internals. */
export interface PluginInstallTarget {
  installLocal(
    directory: string,
    source?: PluginSourceKind,
    approvedCapabilities?: string[],
    origin?: PluginSource,
    scan?: PluginScan,
  ): Promise<PluginManifest>;
  installEnvelope(
    bytes: Buffer,
    source: PluginSourceKind,
    approvedCapabilities?: string[],
    origin?: PluginSource,
    verify?: (manifest: PluginManifest, stage: string) => Promise<PluginScan | undefined>,
  ): Promise<PluginManifest>;
}

/**
 * Numeric dotted compare. A Studio release candidate (0.1.0-rc.1) reads as 0.1.0.1, so it meets
 * its release's minimum and no later one.
 */
export function versionGte(version: string, minimum: string): boolean {
  const a = version.split(".").map((n) => Number.parseInt(n, 10) || 0),
    b = minimum.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0,
      y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** Strictly newer: at least `current` and not equal to it. */
const isNewerVersion = (next: string, current: string) => versionGte(next, current) && !versionGte(current, next);
/** An install whose origin the index can update or reacquire: a pinned GitHub commit or an index entry. */
const isCatalogedOrigin = (origin: PluginSource) =>
  origin.kind === PluginSourceKind.Index || origin.kind === PluginSourceKind.Github;
/**
 * The entry comes from the same publisher, repository and subfolder as the installed plugin; an
 * official plugin's repositories are one source ({@link canonicalSourceRepo}).
 */
const isSameSource = (entry: PluginIndexEntry, manifest: PluginManifest, origin: PluginSource) =>
  entry.publisher === manifest.publisher &&
  canonicalSourceRepo(entry.id, entry.publisher, entry.repo) ===
    canonicalSourceRepo(manifest.id, manifest.publisher, origin.repo ?? "") &&
  (entry.subdir ?? "") === (origin.subdir ?? "");
/** The spec for a pinned `owner/repo` commit, with its subfolder when it has one. */
function githubSpec(repo: string, sha: string, subdir: string | undefined): GithubSpec {
  const [owner = "", name = ""] = repo.split("/");
  const spec: GithubSpec = { repo, owner, name, sha };
  if (subdir) spec.subdir = subdir;
  return spec;
}
/** The first field where a staged manifest differs from what its index entry promised, or "". */
function entryMismatch(entry: PluginIndexEntry, manifest: PluginManifest): string {
  if (manifest.id !== entry.id) return "id";
  if (manifest.version !== entry.version) return "version";
  if (manifest.publisher !== entry.publisher) return "publisher";
  const sorted = (list: string[]) => [...list].sort().join(",");
  return sorted(manifest.capabilities) !== sorted(entry.capabilities) ? "capabilities" : "";
}
/** A git tree mode that links rather than stores: a symlink or a submodule. */
const LINK_MODES = new Set(["120000", "160000"]);
/** The git modes of a regular file, plain or executable. */
const FILE_MODES = new Set(["100644", "100755"]);
type TreeNode = { path?: string; mode?: string; type?: string; sha?: string; size?: number };

/** Why a GitHub API answer stops a lookup (a missing repository or ref, or a rate limit), else null. */
function lookupStop(response: Response): GithubLookupProblem | null {
  if (NOT_THERE.has(response.status)) return GithubLookupProblem.NotFound;
  const limited =
    response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0");
  return limited ? GithubLookupProblem.RateLimited : null;
}

/** A picked version keeps its kind and name; a release keeps its publish date over the commit's. */
function withPickedVersion(pin: Pin, picked: GithubVersion): Pin {
  if ("problem" in pin) return pin;
  const date = picked.kind === GithubVersionKind.Release ? picked.date : pin.version.date;
  return { sha: pin.sha, version: { kind: picked.kind, label: picked.label, ...(date ? { date } : {}) } };
}

/** A lookup that stopped, in the shape the page reads. */
const lookupProblem = (problem: GithubLookupProblem, detail?: string): GithubLookup => ({
  kind: GithubLookupKind.Problem,
  problem,
  ...(detail ? { detail } : {}),
});

/** An API answer as JSON, or the problem that stopped the lookup. */
type Answer = { value: unknown } | { problem: GithubLookupProblem };
/** The commit a link settled on, or the problem that stopped the lookup. */
type Pin = { sha: string; version: GithubVersion } | { problem: GithubLookupProblem };
/** A plugin.json found in a lookup, or why it can't be used. */
type Summary = { found: GithubPluginFound } | { invalid: string };

/** The plugin.json files a lookup reads: the one at the folder itself, else those a few folders below it. */
function manifestNodes(tree: TreeNode[], subdir: string | undefined): TreeNode[] {
  const prefix = subdir ? `${subdir}/` : "";
  const own = tree.find((node) => node.type === "blob" && node.path === `${prefix}plugin.json`);
  if (own) return [own];
  return tree
    .filter((node) => {
      const file = node.path ?? "";
      if (node.type !== "blob" || !file.startsWith(prefix) || !FILE_MODES.has(node.mode ?? "")) return false;
      const folder = manifestFolder(file.slice(prefix.length));
      return (
        folder !== null && !folder.split("/").includes("node_modules") && folder.split("/").length <= LOOKUP_MAX_DEPTH
      );
    })
    .sort((a, b) => (a.path ?? "").localeCompare(b.path ?? ""))
    .slice(0, LOOKUP_MAX_PLUGINS);
}

/**
 * One tree node as a package file under `prefix`, or undefined for a node outside it, a folder or
 * the prefix itself. A link, a submodule, an unusual mode or an oversized file is refused.
 */
function packageBlob(node: TreeNode, prefix: string): GithubBlob | undefined {
  const file = node?.path ?? "";
  const inPackage = typeof file === "string" && file !== "" && (!prefix || file.startsWith(prefix));
  if (!inPackage) return undefined;
  if (node.mode !== undefined && LINK_MODES.has(node.mode)) throw new Error(MESSAGE.LinksInPackage);
  if (node.type !== "blob") return undefined;
  if (node.mode === undefined || !FILE_MODES.has(node.mode)) throw new Error(MESSAGE.FileMode(node.mode, file));
  const relative = file.slice(prefix.length);
  if (!relative) return undefined;
  assertRelativePath(relative);
  // The repository around a package (`.github/`, `.gitignore`, an author's AGENTS.md) is not installed.
  if (!isPackagePath(relative)) return undefined;
  const size = typeof node.size === "number" ? node.size : 0;
  if (size > FILE_MAX_BYTES) throw new Error(MESSAGE.FileTooLarge(relative));
  return { path: file, relative, sha: typeof node.sha === "string" ? node.sha : "", size };
}

export function parseGithubSpec(spec: unknown): GithubSpec {
  if (typeof spec !== "string") throw new Error(MESSAGE.InvalidSpec);
  const at = spec.lastIndexOf("@");
  const location = at < 0 ? "" : spec.slice(0, at).trim(),
    sha =
      at < 0
        ? ""
        : spec
            .slice(at + 1)
            .trim()
            .toLowerCase();
  if (!SHA.test(sha)) throw new Error(MESSAGE.SpecNeedsSha);
  const parts = location.split("/");
  const owner = parts[0] ?? "",
    name = parts[1] ?? "",
    subdir = parts.slice(2).join("/");
  if (!REPO.test(`${owner}/${name}`)) throw new Error(MESSAGE.SpecNeedsRepo);
  if (subdir) assertRelativePath(subdir);
  const parsed: GithubSpec = { repo: `${owner}/${name}`, owner, name, sha };
  if (subdir) parsed.subdir = subdir;
  return parsed;
}

const hasListingText = (e: PluginIndexEntry) =>
  typeof e.name === "string" &&
  e.name !== "" &&
  typeof e.publisher === "string" &&
  e.publisher !== "" &&
  typeof e.description === "string";
const isKnownTier = (tier: unknown) => tier === PluginTier.Official || tier === PluginTier.Community;
const isStringList = (value: unknown) => Array.isArray(value) && value.every((c) => typeof c === "string");
const isPinnedArtifact = (artifact: PluginIndexEntry["artifact"]) =>
  Boolean(artifact?.url?.startsWith("https://")) && SHA256.test(artifact?.sha256 ?? "");

/** The listing fields of an entry: what it is called and where it sits. */
function validateEntryListing(e: PluginIndexEntry): void {
  if (!hasListingText(e)) throw new Error(MESSAGE.InvalidEntry(e.id));
  if (!(PLUGIN_CATEGORIES as readonly string[]).includes(e.category)) throw new Error(MESSAGE.InvalidCategory(e.id));
  if (!isKnownTier(e.tier)) throw new Error(MESSAGE.InvalidTier(e.id));
}

/** The source fields of an entry: the pinned repository, commit and version, what it may do, and its links. */
function validateEntrySource(e: PluginIndexEntry): void {
  if (!REPO.test(e.repo ?? "")) throw new Error(MESSAGE.InvalidRepo(e.id));
  if (!SHA.test(e.sha ?? "")) throw new Error(MESSAGE.InvalidSha(e.id));
  if (!VERSION.test(e.version ?? "")) throw new Error(MESSAGE.InvalidVersion(e.id));
  if (!isStringList(e.capabilities)) throw new Error(MESSAGE.InvalidCapabilities(e.id));
  if (e.subdir !== undefined) assertRelativePath(e.subdir);
  if (e.minStudioVersion !== undefined && !VERSION.test(e.minStudioVersion))
    throw new Error(MESSAGE.InvalidMinStudioVersion(e.id));
  if (e.docsUrl !== undefined && !e.docsUrl.startsWith("https://")) throw new Error(MESSAGE.InsecureLinks(e.id));
  if (e.artifact !== undefined && !isPinnedArtifact(e.artifact)) throw new Error(MESSAGE.InvalidArtifact(e.id));
}

/** The index format this Studio reads and writes. */
const INDEX_VERSION = 1;

/** The index's own fields: an object of the version this Studio reads, dated, with a plugin list. */
const isIndexShape = (v: PluginIndex) =>
  Boolean(v) &&
  typeof v === "object" &&
  v.version === INDEX_VERSION &&
  typeof v.updatedAt === "string" &&
  Array.isArray(v.plugins);

export function validateIndex(value: unknown): PluginIndex {
  const v = value as PluginIndex;
  if (!isIndexShape(v)) throw new Error(MESSAGE.InvalidIndex);
  const seen = new Set<string>();
  const plugins = v.plugins.map((raw): PluginIndexEntry => {
    const e = raw as PluginIndexEntry;
    if (!e || typeof e !== "object" || !isPluginId(e.id)) throw new Error(MESSAGE.InvalidEntryId);
    if (seen.has(e.id)) throw new Error(MESSAGE.DuplicateEntry(e.id));
    seen.add(e.id);
    validateEntryListing(e);
    validateEntrySource(e);
    const entry: PluginIndexEntry = {
      id: e.id,
      name: e.name,
      publisher: e.publisher,
      description: e.description,
      category: e.category,
      tier: e.tier,
      repo: e.repo,
      sha: e.sha.toLowerCase(),
      version: e.version,
      capabilities: [...e.capabilities],
    };
    if (e.subdir !== undefined) entry.subdir = e.subdir;
    if (e.minStudioVersion !== undefined) entry.minStudioVersion = e.minStudioVersion;
    if (e.docsUrl !== undefined) entry.docsUrl = e.docsUrl;
    if (e.artifact !== undefined) entry.artifact = { url: e.artifact.url, sha256: e.artifact.sha256.toLowerCase() };
    return entry;
  });
  return { version: INDEX_VERSION, updatedAt: v.updatedAt, plugins };
}

/**
 * What the catalog's own CI enforces (its `policy.json`), held by the app as well: the index is
 * unsigned, so "official" and an artifact's origin must not be whatever the index says. Community
 * entries are listed after maintainer review, their artifacts hosted on an approved origin; signing
 * the index with a key embedded here is later hardening.
 */
export interface CatalogPolicy {
  /** Origins an artifact may be downloaded from; its path must end in `/<id>/<version>/<sha256>.json`. */
  artifactOrigins: readonly string[];
  /**
   * The only publisher that may list each official id, and the source repositories its records may
   * name: the first is where new records point, and any of them is the same source.
   */
  official: Readonly<Record<string, { publisher: string; repos: readonly [string, ...string[]] }>>;
}
/**
 * The official source moved to genex-games/genex-desktop. The published catalog's records are
 * immutable and still name Rabneba/ai-game-studio, so the legacy repository stays accepted until
 * every official record names the new one (the next Genex and Blender releases).
 */
const OFFICIAL_REPOS = ["genex-games/genex-desktop", "Rabneba/ai-game-studio"] as const;
export const STUDIO_CATALOG_POLICY: CatalogPolicy = {
  artifactOrigins: [CATALOG_ORIGIN],
  official: {
    genex: { publisher: "Genex", repos: OFFICIAL_REPOS },
    blender: { publisher: "Studio", repos: OFFICIAL_REPOS },
  },
};

/** The policy's reservation for an official id, or undefined for any other id. */
const officialFor = (id: string, policy: CatalogPolicy) =>
  Object.hasOwn(policy.official, id) ? policy.official[id] : undefined;

/**
 * The repository a plugin's identity names: an official plugin's current repository when it came
 * from any of its official ones, so moving the source is not a change of identity; otherwise `repo`.
 */
export function canonicalSourceRepo(
  id: string,
  publisher: string,
  repo: string,
  policy: CatalogPolicy = STUDIO_CATALOG_POLICY,
): string {
  const official = officialFor(id, policy);
  const isOfficialSource = official?.publisher === publisher && official.repos.includes(repo);
  return official && isOfficialSource ? official.repos[0] : repo;
}

/** An artifact from an allowed origin, at the immutable `/<id>/<version>/<sha256>.json` address. */
function isAllowedArtifact(
  entry: PluginIndexEntry,
  artifact: NonNullable<PluginIndexEntry["artifact"]>,
  policy: CatalogPolicy,
) {
  const url = new URL(artifact.url);
  const extras = Boolean(url.search || url.hash || url.username || url.password);
  if (!policy.artifactOrigins.includes(url.origin) || extras) return false;
  return url.pathname.endsWith(`/${entry.id}/${entry.version}/${artifact.sha256}.json`);
}

/**
 * Apply the policy to a validated index. An entry under an official id from any other publisher or
 * repository is refused, as is an artifact from an unknown origin or at a mutable address; an
 * "official" label the policy does not grant is shown as community.
 */
export function applyCatalogPolicy(index: PluginIndex, policy: CatalogPolicy): PluginIndex {
  const plugins: PluginIndexEntry[] = [];
  for (const entry of index.plugins) {
    const reserved = officialFor(entry.id, policy);
    const impostor = reserved && (entry.publisher !== reserved.publisher || !reserved.repos.includes(entry.repo));
    if (impostor) continue;
    if (entry.artifact && !isAllowedArtifact(entry, entry.artifact, policy)) continue;
    plugins.push(entry.tier === PluginTier.Official && !reserved ? { ...entry, tier: PluginTier.Community } : entry);
  }
  return { ...index, plugins };
}

export class PluginMarketplace {
  readonly root: string;
  readonly studioVersion: string;
  readonly defaultUrl: string;
  readonly offline: boolean;
  #fetch: typeof fetch;
  #entries: PluginIndexEntry[] = [];
  constructor(options: {
    root: string;
    studioVersion: string;
    fetchImpl?: typeof fetch;
    defaultUrl?: string;
    offline?: boolean;
  }) {
    this.root = options.root;
    this.studioVersion = options.studioVersion;
    this.defaultUrl = options.defaultUrl ?? DEFAULT_INDEX_URL;
    this.offline = options.offline === true;
    this.#fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }
  #cacheFile() {
    return path.join(this.root, "cache", "index.json");
  }
  /**
   * Every outbound call goes through here. An offline profile — every fixture profile — can reach
   * the network by no path at all, not just by skipping the index fetch.
   */
  #request(input: string, init: RequestInit): Promise<Response> {
    if (this.offline) return Promise.reject(new Error(MESSAGE.Offline));
    return this.#fetch(input, init);
  }
  /** Host-owned override, outside any plugin's storage; https only so an index can never be served over plain http. */
  async indexUrl(): Promise<string> {
    const override = JSON.parse(await readFile(path.join(this.root, "marketplace.json"), "utf8").catch(() => "{}")) as {
      indexUrl?: unknown;
    };
    if (typeof override.indexUrl !== "string" || !override.indexUrl) return this.defaultUrl;
    if (!override.indexUrl.startsWith("https://")) throw new Error(MESSAGE.InsecureIndexUrl);
    return override.indexUrl;
  }
  async #cache(): Promise<CachedIndex | null> {
    try {
      const raw = JSON.parse(await readFile(this.#cacheFile(), "utf8")) as CachedIndex;
      const complete = Boolean(raw) && typeof raw.url === "string" && typeof raw.fetchedAt === "number";
      if (!complete) return null;
      const { index, rejected } = readableIndex(raw.index);
      return { url: raw.url, fetchedAt: raw.fetchedAt, index, rejected: rejected + (raw.rejected ?? 0) };
    } catch {
      return null;
    }
  }
  async #read(response: Response, cap: number, what: string): Promise<Buffer> {
    if (!response.ok) throw new Error(MESSAGE.DownloadFailed(what, response.status));
    const body = response.body;
    if (!body) return Buffer.from(await response.arrayBuffer());
    const reader = body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > cap) {
        await reader.cancel();
        throw new Error(MESSAGE.DownloadTooLarge(what, cap));
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }
  /** Cached for 6 h; a failure serves the last good copy marked stale rather than an empty marketplace. */
  async index(refresh = false, installed: PluginInfo[] = []): Promise<PluginIndexView> {
    let url = this.defaultUrl,
      error: string | undefined;
    try {
      url = await this.indexUrl();
    } catch (e) {
      error = errorMessage(e);
    }
    const cache = await this.#cache();
    const usable = cache && cache.url === url ? cache : null;
    if (error) return this.#view(url, usable, true, error, installed);
    if (this.offline) return this.#view(url, usable, true, MESSAGE.Offline, installed);
    if (usable && !refresh && Date.now() - usable.fetchedAt < INDEX_TTL_MS)
      return this.#view(url, usable, false, undefined, installed);
    try {
      const response = await this.#request(url, {
        signal: AbortSignal.timeout(INDEX_TIMEOUT_MS),
        redirect: "error",
        headers: { Accept: "application/json" },
      });
      const { index, rejected } = readableIndex(
        JSON.parse((await this.#read(response, INDEX_MAX_BYTES, MESSAGE.IndexDownload)).toString("utf8")),
      );
      const fresh: CachedIndex = { url, fetchedAt: Date.now(), index, rejected };
      await mkdir(path.dirname(this.#cacheFile()), { recursive: true, mode: 0o700 });
      await atomicWriteJson(this.#cacheFile(), fresh);
      return this.#view(url, fresh, false, undefined, installed);
    } catch (e) {
      return this.#view(url, usable, true, errorMessage(e), installed);
    }
  }
  #view(
    url: string,
    cache: CachedIndex | null,
    stale: boolean,
    error: string | undefined,
    installed: PluginInfo[],
  ): PluginIndexView {
    // Applied on every read, cached copies included, so a policy change in the app takes effect at once.
    const entries = cache ? applyCatalogPolicy(cache.index, STUDIO_CATALOG_POLICY).plugins : [];
    this.#entries = entries;
    const view: PluginIndexView = {
      url,
      studioVersion: this.studioVersion,
      fetchedAt: cache ? cache.fetchedAt : null,
      stale,
      entries,
      updates: this.updates(installed),
    };
    if (error) view.error = error;
    else if (cache?.rejected)
      view.error = `Ignored ${cache.rejected} invalid catalog ${cache.rejected === 1 ? "entry" : "entries"}.`;
    return view;
  }
  /** Updates are reported, never applied: an update can widen capabilities and must be re-approved. */
  updates(installed: PluginInfo[]): PluginIndexView["updates"] {
    const out: PluginIndexView["updates"] = [];
    for (const p of installed) {
      const entry = this.#updateFor(p);
      if (entry)
        out.push({ id: entry.id, installedVersion: p.manifest.version, version: entry.version, sha: entry.sha });
    }
    return out;
  }
  /** The index entry that updates an installed cataloged plugin: a newer version from the same source. */
  #updateFor(p: PluginInfo): PluginIndexEntry | undefined {
    const origin = p.origin;
    if (p.removed || !origin || !isCatalogedOrigin(origin)) return undefined;
    const entry = this.#entries.find((e) => e.id === p.manifest.id);
    if (!entry || !origin.sha || entry.sha === origin.sha) return undefined;
    // A catalog refresh must not downgrade/repack a version or take over another source.
    if (!isNewerVersion(entry.version, p.manifest.version) || !isSameSource(entry, p.manifest, origin))
      return undefined;
    if (entry.minStudioVersion && !versionGte(this.studioVersion, entry.minStudioVersion)) return undefined;
    return entry;
  }
  entry(id: string): PluginIndexEntry | undefined {
    return this.#entries.find((e) => e.id === id);
  }
  /** Refuse before any download: an index entry that needs a newer Studio cannot be made to work by installing it. */
  #requireStudio(entry: PluginIndexEntry) {
    if (entry.minStudioVersion && !versionGte(this.studioVersion, entry.minStudioVersion))
      throw new Error(MESSAGE.NeedsNewerStudio(entry.name, entry.minStudioVersion));
  }
  async #json(url: string, cap: number, what: string): Promise<unknown> {
    const response = await this.#request(url, {
      signal: AbortSignal.timeout(INDEX_TIMEOUT_MS),
      redirect: "error",
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
    return JSON.parse((await this.#read(response, cap, what)).toString("utf8"));
  }
  /** The pinned commit's own tree: no branch, no tag, no archive, no link or submodule may enter a package. */
  async fetchGithubTree(repo: string, sha: string, subdir?: string): Promise<GithubBlob[]> {
    if (!REPO.test(repo)) throw new Error(MESSAGE.InvalidRepository);
    if (!SHA.test(sha)) throw new Error(MESSAGE.SpecNeedsSha);
    const tree = (await this.#json(
      `https://api.github.com/repos/${repo}/git/trees/${sha}?recursive=1`,
      INDEX_MAX_BYTES * 8,
      MESSAGE.TreeDownload,
    )) as { truncated?: boolean; tree?: TreeNode[] };
    if (tree?.truncated) throw new Error(MESSAGE.TreeTruncated);
    if (!Array.isArray(tree?.tree)) throw new Error(MESSAGE.TreeUnreadable);
    const prefix = subdir ? `${subdir}/` : "";
    const blobs: GithubBlob[] = [];
    let total = 0;
    for (const node of tree.tree) {
      const blob = packageBlob(node, prefix);
      if (!blob) continue;
      total += blob.size;
      if (total > TREE_MAX_BYTES) throw new Error(MESSAGE.PackageTooLarge);
      if (!SHA.test(blob.sha)) throw new Error(MESSAGE.MissingObjectId(blob.relative));
      blobs.push(blob);
      if (blobs.length > TREE_MAX_FILES) throw new Error(MESSAGE.TooManyFiles);
    }
    if (!blobs.some((b) => b.relative === "plugin.json")) throw new Error(MESSAGE.NoManifest);
    return blobs;
  }
  /** Writes the pinned files into a staging folder and reports what the code appears to do; the caller installs and removes the stage. */
  async stageGithub(
    spec: string | GithubSpec,
    kind: PluginSourceKind = PluginSourceKind.Github,
  ): Promise<StagedPackage> {
    const parsed = typeof spec === "string" ? parseGithubSpec(spec) : spec;
    const blobs = await this.fetchGithubTree(parsed.repo, parsed.sha, parsed.subdir);
    const stage = path.join(this.root, "staging", randomUUID());
    await mkdir(stage, { recursive: true, mode: 0o700 });
    try {
      for (const blob of blobs) {
        // Every path segment is encoded: a name with a space, a `#` or a `?` must fetch the file it
        // names, not a truncated or differently-addressed one. Repo and sha are already pattern-checked.
        const location = blob.path.split("/").map(encodeURIComponent).join("/");
        const response = await this.#request(
          `https://raw.githubusercontent.com/${parsed.repo}/${parsed.sha}/${location}`,
          { signal: AbortSignal.timeout(INDEX_TIMEOUT_MS), redirect: "error" },
        );
        const bytes = await this.#read(response, FILE_MAX_BYTES, MESSAGE.FileDownload(blob.relative));
        const objectId = createHash("sha1")
          .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
          .digest("hex");
        if (objectId !== blob.sha) throw new Error(MESSAGE.IntegrityFailed(blob.relative));
        const destination = path.join(stage, assertRelativePath(blob.relative));
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, bytes);
      }
      const manifest = await inspectPackage(stage);
      const scan = await scanPackage(stage, manifest);
      const origin: PluginSource = { kind, repo: parsed.repo, sha: parsed.sha };
      if (parsed.subdir) origin.subdir = parsed.subdir;
      return { stage, manifest, scan, origin };
    } catch (e) {
      await rm(stage, { recursive: true, force: true });
      throw e;
    }
  }
  /** One GitHub API answer as JSON, or the problem that stops a lookup; any other failure throws. */
  async #githubApi(url: string): Promise<Answer> {
    const response = await this.#request(url, {
      signal: AbortSignal.timeout(INDEX_TIMEOUT_MS),
      redirect: "error",
      headers: GITHUB_HEADERS,
    });
    const problem = lookupStop(response);
    if (problem) return { problem };
    return {
      value: JSON.parse((await this.#read(response, INDEX_MAX_BYTES, MESSAGE.LookupDownload)).toString("utf8")),
    };
  }
  /** The commit a branch, tag or release points at now. */
  async #commitAt(repo: string, ref: string, kind: GithubVersionKind): Promise<Pin> {
    const answer = await this.#githubApi(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`);
    if ("problem" in answer) return answer;
    const commit = answer.value as { sha?: unknown; commit?: { committer?: { date?: unknown } } };
    const sha = typeof commit?.sha === "string" ? commit.sha.toLowerCase() : "";
    if (!SHA.test(sha)) throw new Error(MESSAGE.CommitUnreadable);
    const date = commit.commit?.committer?.date;
    return { sha, version: { kind, label: ref, ...(typeof date === "string" ? { date } : {}) } };
  }
  /** The latest release's commit, or the default branch's newest when there is no release. */
  async #latest(repo: string): Promise<Pin> {
    const release = await this.#githubApi(`https://api.github.com/repos/${repo}/releases/latest`);
    if ("value" in release) {
      const { tag_name: tag, published_at: date } = (release.value ?? {}) as {
        tag_name?: unknown;
        published_at?: unknown;
      };
      if (typeof tag !== "string" || !tag) throw new Error(MESSAGE.ReleaseUnreadable);
      const pinned = await this.#commitAt(repo, tag, GithubVersionKind.Release);
      if ("problem" in pinned) return pinned;
      return {
        sha: pinned.sha,
        version: { kind: GithubVersionKind.Release, label: tag, ...(typeof date === "string" ? { date } : {}) },
      };
    }
    // No release and no repository answer alike; the repository itself tells them apart.
    if (release.problem !== GithubLookupProblem.NotFound) return release;
    const repository = await this.#githubApi(`https://api.github.com/repos/${repo}`);
    if ("problem" in repository) return repository;
    const branch = (repository.value as { default_branch?: unknown } | null)?.default_branch;
    if (typeof branch !== "string" || !branch) throw new Error(MESSAGE.RepositoryUnreadable);
    return this.#commitAt(repo, branch, GithubVersionKind.Branch);
  }
  /** The exact commit a link names: a version picked from its list, its commit, its ref, or the latest version. */
  #pin(link: GithubLink, picked?: GithubVersion): Promise<Pin> {
    if (picked)
      return this.#commitAt(link.repo, picked.label, picked.kind).then((pin) => withPickedVersion(pin, picked));
    if (link.sha)
      return Promise.resolve({
        sha: link.sha,
        version: { kind: GithubVersionKind.Commit, label: link.sha.slice(0, SHORT_SHA_CHARS) },
      });
    if (link.ref) return this.#commitAt(link.repo, link.ref, GithubVersionKind.Ref);
    return this.#latest(link.repo);
  }
  /** One plugin.json at the pinned commit, checked against the tree's object id and read as a manifest. */
  async #summary(repo: string, pin: { sha: string; version: GithubVersion }, node: TreeNode): Promise<Summary> {
    const file = node.path ?? "";
    const location = file.split("/").map(encodeURIComponent).join("/");
    const response = await this.#request(`https://raw.githubusercontent.com/${repo}/${pin.sha}/${location}`, {
      signal: AbortSignal.timeout(INDEX_TIMEOUT_MS),
      redirect: "error",
    });
    const bytes = await this.#read(response, FILE_MAX_BYTES, MESSAGE.FileDownload(file));
    const objectId = createHash("sha1")
      .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
      .digest("hex");
    if (objectId !== node.sha) throw new Error(MESSAGE.IntegrityFailed(file));
    let manifest: PluginManifest;
    try {
      manifest = validateManifest(JSON.parse(bytes.toString("utf8")));
    } catch (e) {
      return { invalid: e instanceof SyntaxError ? MESSAGE.ManifestNotJson : errorMessage(e) };
    }
    const subdir = manifestFolder(file) || undefined;
    const { id, name, description, publisher, version } = manifest;
    return {
      found: {
        repo,
        sha: pin.sha,
        ...(subdir ? { subdir } : {}),
        spec: pinnedSpec(repo, pin.sha, subdir),
        version: pin.version,
        plugin: { id, name, description, publisher, version },
      },
    };
  }
  /**
   * What a pasted GitHub link leads to, before anything is downloaded for install: the link settles
   * on one exact commit (its own, its branch's or tag's, else the latest release or the default
   * branch's newest), and that commit's plugin.json says what the plugin is. Several plugins in one
   * repository come back to choose from. The install then fetches exactly that commit.
   */
  async lookupGithub(input: string, picked?: GithubVersion): Promise<GithubLookup> {
    const link = parseGithubLink(input);
    if (!link) return lookupProblem(GithubLookupProblem.NotALink);
    const pin = await this.#pin(link, picked);
    if ("problem" in pin) return lookupProblem(pin.problem);
    const tree = (await this.#json(
      `https://api.github.com/repos/${link.repo}/git/trees/${pin.sha}?recursive=1`,
      INDEX_MAX_BYTES * 8,
      MESSAGE.TreeDownload,
    )) as { truncated?: boolean; tree?: TreeNode[] };
    if (!Array.isArray(tree?.tree)) throw new Error(MESSAGE.TreeUnreadable);
    const nodes = manifestNodes(tree.tree, link.subdir);
    if (!nodes.length)
      return lookupProblem(
        tree.truncated ? GithubLookupProblem.NotFound : GithubLookupProblem.NoPlugin,
        tree.truncated ? MESSAGE.TreeTruncated : undefined,
      );
    const summaries: Summary[] = [];
    for (const node of nodes) summaries.push(await this.#summary(link.repo, pin, node));
    const found = summaries.flatMap((s) => ("found" in s ? [s.found] : []));
    const [only] = found;
    if (!only) {
      const first = summaries[0];
      return lookupProblem(GithubLookupProblem.InvalidPlugin, first && "invalid" in first ? first.invalid : undefined);
    }
    if (found.length === 1) return { kind: GithubLookupKind.Plugin, ...only };
    return { kind: GithubLookupKind.Choose, repo: link.repo, version: pin.version, plugins: found };
  }
  /** A repository's recent releases (newest first, drafts left out) and its default branch, to pick another version from. */
  async githubVersions(repo: string): Promise<GithubVersion[]> {
    if (!REPO.test(repo) || repo.split("/").some((part) => part === "." || part === ".."))
      throw new Error(MESSAGE.InvalidRepository);
    const [releases, repository] = await Promise.all([
      this.#githubApi(`https://api.github.com/repos/${repo}/releases?per_page=${VERSIONS_LISTED}`),
      this.#githubApi(`https://api.github.com/repos/${repo}`),
    ]);
    const listed = "value" in releases && Array.isArray(releases.value) ? (releases.value as unknown[]) : [];
    const versions: GithubVersion[] = listed.flatMap((entry) => {
      const { tag_name: tag, published_at: date, draft } = (entry ?? {}) as Record<string, unknown>;
      if (draft === true || typeof tag !== "string" || !tag) return [];
      return [{ kind: GithubVersionKind.Release, label: tag, ...(typeof date === "string" ? { date } : {}) }];
    });
    const branch =
      "value" in repository ? (repository.value as { default_branch?: unknown } | null)?.default_branch : undefined;
    if (typeof branch === "string" && branch) versions.push({ kind: GithubVersionKind.Branch, label: branch });
    return versions;
  }
  /**
   * Put a removed cataloged plugin back where its record says it came from: the commit that record
   * pins, staged and scanned again, and approved against THAT code — never against the manifest the
   * old install record happens to carry. When the index has since moved to another commit, the
   * dialog says so instead of quietly installing a commit nobody approved.
   */
  async reacquire(
    info: PluginInfo,
    target: PluginInstallTarget,
    confirm?: (manifest: PluginManifest, scan: PluginScan, origin: PluginSource, note?: string) => Promise<boolean>,
  ): Promise<void> {
    const origin = info.origin;
    if (!origin || !isCatalogedOrigin(origin)) throw new Error(MESSAGE.OriginUnknown);
    const capabilities = info.manifest.capabilities;
    if (origin.repo && origin.sha && !origin.url) {
      const note = await this.#movedPinNote(info, origin, origin.sha);
      const staged = await this.stageGithub(githubSpec(origin.repo, origin.sha, origin.subdir), origin.kind);
      try {
        if (confirm && !(await confirm(staged.manifest, staged.scan, staged.origin, note)))
          throw new UserCancelledError();
        await target.installLocal(staged.stage, origin.kind, capabilities, staged.origin, staged.scan);
      } finally {
        await rm(staged.stage, { recursive: true, force: true });
      }
      return;
    }
    // An artifact entry, or a record with no commit of its own: the index decides, and says so.
    await this.index();
    await this.installIndex(
      info.manifest.id,
      target,
      capabilities,
      confirm ? (manifest, scan, source) => confirm(manifest, scan, source) : undefined,
    );
  }
  /** When an index install's entry now pins another commit, what the reinstall dialog tells the user. */
  async #movedPinNote(info: PluginInfo, origin: PluginSource, sha: string): Promise<string | undefined> {
    if (origin.kind !== PluginSourceKind.Index) return undefined;
    await this.index();
    const listed = this.entry(info.manifest.id)?.sha;
    if (!listed || listed === sha) return undefined;
    const short = listed.slice(0, PIN_PREVIEW_CHARS);
    return MESSAGE.MovedPin(short);
  }
  /** What the index promised must be what the pinned code declares, or the user approved the wrong thing. */
  #requireMatch(entry: PluginIndexEntry, manifest: PluginManifest) {
    const mismatch = entryMismatch(entry, manifest);
    if (mismatch) throw new Error(MESSAGE.EntryMismatch(mismatch));
  }
  /**
   * Install a cataloged plugin: the pinned commit, or the curated artifact envelope when the entry carries one.
   * `confirm` runs on the staged copy, after the index/manifest match and the scan, so the host's trust dialog
   * describes the code that is about to be installed rather than what the catalog promised; `false` cancels.
   */
  async installIndex(
    id: string,
    target: PluginInstallTarget,
    approvedCapabilities?: string[],
    confirm?: (manifest: PluginManifest, scan: PluginScan, origin: PluginSource) => Promise<boolean>,
  ): Promise<InstalledPackage> {
    const entry = this.entry(id);
    if (!entry) throw new Error(MESSAGE.NotInIndex);
    this.#requireStudio(entry);
    const origin: PluginSource = { kind: PluginSourceKind.Index, repo: entry.repo, sha: entry.sha };
    if (entry.subdir) origin.subdir = entry.subdir;
    if (entry.artifact)
      return this.#installArtifact(entry, entry.artifact, origin, target, approvedCapabilities, confirm);
    const staged = await this.stageGithub(githubSpec(entry.repo, entry.sha, entry.subdir), PluginSourceKind.Index);
    try {
      this.#requireMatch(entry, staged.manifest);
      if (confirm && !(await confirm(staged.manifest, staged.scan, staged.origin))) throw new UserCancelledError();
      await target.installLocal(staged.stage, PluginSourceKind.Index, approvedCapabilities, staged.origin, staged.scan);
      return { manifest: staged.manifest, scan: staged.scan, origin: staged.origin };
    } finally {
      await rm(staged.stage, { recursive: true, force: true });
    }
  }
  /** The curated artifact envelope: downloaded, checked against its digest, matched, scanned and confirmed. */
  async #installArtifact(
    entry: PluginIndexEntry,
    artifact: NonNullable<PluginIndexEntry["artifact"]>,
    origin: PluginSource,
    target: PluginInstallTarget,
    approvedCapabilities: string[] | undefined,
    confirm: ((manifest: PluginManifest, scan: PluginScan, origin: PluginSource) => Promise<boolean>) | undefined,
  ): Promise<InstalledPackage> {
    origin.url = artifact.url;
    origin.sha256 = artifact.sha256;
    const response = await this.#request(artifact.url, {
      signal: AbortSignal.timeout(ARTIFACT_TIMEOUT_MS),
      redirect: "error",
    });
    const bytes = await this.#read(response, MAX_ARTIFACT_BYTES, MESSAGE.PluginDownload);
    if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new Error(MESSAGE.DigestMismatch);
    let scanned: PluginScan | undefined;
    const manifest = await target.installEnvelope(
      bytes,
      PluginSourceKind.Index,
      approvedCapabilities,
      origin,
      async (inspected, stage) => {
        this.#requireMatch(entry, inspected);
        const scan = await scanPackage(stage, inspected);
        scanned = scan;
        if (confirm && !(await confirm(inspected, scan, origin))) throw new UserCancelledError();
        return scan;
      },
    );
    if (!scanned) throw new Error(MESSAGE.Unscanned);
    return { manifest, scan: scanned, origin };
  }
}
