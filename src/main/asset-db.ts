/**
 * The asset database: `genex-assets.lock` beside a Rust game's `genex.toml`, committed with the
 * game and written by the host alone, like a cargo lock (shapes in `shared/asset-db.ts`).
 *
 * Each source asset keeps one id for its life: random at first sight, kept when the file is
 * edited in place, and kept across a rename when a vanished path's sha256 reappears at a new one.
 * The lock carries a digest of its own body; a lock whose digest does not match was edited by
 * hand (or by an agent) and is rewritten from the files, keeping only the ids whose path and
 * sha256 still match a file, and the import step reports `lock-edited`. Rows are sorted, so two
 * imports of one tree write byte-identical files. A row whose path breaks the relative-path rule
 * is ignored and never read; the lock's paths are never opened at all, only matched against the
 * files the asset walk found.
 */
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { constants as FS } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import {
  atomicWriteText,
  isJsonObject,
  NotARegularFileError,
  openNoFollow,
  readRegularFile,
} from "../substrate/fsx.ts";
import { assertRelativePath } from "../substrate/paths.ts";
import { ASSET_FORMATS, type AssetKind, type AssetSource, assetKind } from "../shared/game-assets.ts";
import { BakeKind, isBakeName } from "../shared/native-contract.ts";
import {
  ASSET_LOCK_FILE,
  ASSET_LOCK_VERSION,
  type AssetImportSettings,
  AssetLicence,
  type AssetLock,
  type AssetLockDerived,
  type AssetLockEntry,
  type AssetLockOutput,
  AssetOrigin,
  type ImportIssue,
  ImportIssueCode,
  TextureUsageSource,
} from "../shared/asset-db.ts";
import type { AssetEntry } from "./game-assets.ts";

/** The largest lock this host reads; a bigger one is treated as edited and rewritten. */
const LOCK_MAX_BYTES = 8 * 1024 * 1024;
/** How many random bytes an id holds (16 lowercase hex characters). */
const ID_BYTES = 8;
const ID_PATTERN = /^[0-9a-f]{16}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** The digest field's prefix: the algorithm, so a later format can change it. */
const DIGEST_PREFIX = "sha256:";

const MESSAGE = {
  UnknownInput: (id: string) => `A derived row names an input the lock does not hold: ${id}`,
  BadDerived: "A derived row needs a bake kind, a bake name, a params digest, a sha256 and a byte count.",
  IdsExhausted: "Could not mint an asset id the lock does not hold.",
} as const;

/** What a read of the lock found. Wire-free: the import step branches on it. */
export const AssetLockState = {
  /** No lock beside `genex.toml` yet. */
  Missing: "missing",
  /** The lock's digest matched its body. */
  Trusted: "trusted",
  /** Not JSON, not a regular file, too large, or its digest did not match: someone edited it. */
  Edited: "edited",
  /** A lock of another format version: rewritten from the files, nothing kept. */
  OtherVersion: "other-version",
} as const;
export type AssetLockState = (typeof AssetLockState)[keyof typeof AssetLockState];

/** A read of the lock: its usable rows, and what was refused. */
export interface AssetLockRead {
  state: AssetLockState;
  /** The lock's text as read, when it was read as a regular file (to skip an unchanged write). */
  text: string | null;
  /** Rows whose id, path and sha256 are well-formed, each id and path once. */
  entries: AssetLockEntry[];
  derived: AssetLockDerived[];
  /** The paths of rows that were dropped: hostile, malformed or repeated. */
  ignored: string[];
}

/** What the import step knows about one source this time; what it leaves out carries over. */
export interface AssetLockFacts {
  /** Posix path relative to the game folder. */
  path: string;
  sha256: string;
  kind: AssetKind;
  origin?: AssetOrigin;
  licence?: AssetLicence;
  source?: AssetLockEntry["source"];
  settings?: AssetImportSettings;
  importer?: string;
  /** Game-relative paths of the sources this one reads; a path that is not a source is dropped. */
  deps?: string[];
  outputs?: AssetLockOutput[];
  issues?: ImportIssue[];
}

/** How {@link resolveAssetLock} mints ids; tests pass a counter. */
export interface ResolveOptions {
  newId?: () => string;
}

/** A resolved lock and what the import step reports about the lock itself. */
export interface AssetLockResolution {
  lock: AssetLock;
  /** `lock-edited` when the old lock's digest did not match. */
  issues: ImportIssue[];
}

/** What {@link refreshAssetLock} did. */
export interface AssetLockRefresh extends AssetLockResolution {
  /** False when the lock on disk already held exactly this text. */
  written: boolean;
  /** Rows of the old lock that were dropped (hostile, malformed or repeated paths). */
  ignored: string[];
}

/** Every asset kind: the format table's, and `other` for a file it does not list. */
const KINDS: ReadonlySet<string> = new Set([
  ...Object.values(ASSET_FORMATS).map((format) => format.kind),
  assetKind(""),
]);
const ORIGINS: ReadonlySet<string> = new Set(Object.values(AssetOrigin));
const LICENCES: ReadonlySet<string> = new Set(Object.values(AssetLicence));
const USAGE_SOURCES: ReadonlySet<string> = new Set(Object.values(TextureUsageSource));
const ISSUE_CODES: ReadonlySet<string> = new Set(Object.values(ImportIssueCode));
const BAKE_KINDS: ReadonlySet<string> = new Set(Object.values(BakeKind));

/** Byte order, so the sort never depends on the host's locale. */
function byText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** A path a lock row may hold: relative, `/`-separated, never climbing (`assertRelativePath`). */
function isLockPath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    assertRelativePath(value);
    return true;
  } catch {
    return false;
  }
}

const isString = (value: unknown): value is string => typeof value === "string";
const isSha256 = (value: unknown): value is string => isString(value) && SHA256_HEX.test(value);
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** The digest the lock carries: sha256 of its version, entries and derived rows as JSON. */
function bodyDigest(version: unknown, entries: unknown, derived: unknown): string {
  const body = JSON.stringify({ version, entries, derived });
  return DIGEST_PREFIX + createHash("sha256").update(body).digest("hex");
}

/** The lock as committed: pretty JSON with its own digest, one trailing newline. */
export function serializeAssetLock(lock: AssetLock): string {
  const digest = bodyDigest(lock.version, lock.entries, lock.derived);
  const file = { version: lock.version, digest, entries: lock.entries, derived: lock.derived };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Settings as the lock writes them: a usage and its source, each only when present. */
function settingsOf(value: unknown): AssetImportSettings {
  if (!isJsonObject(value)) return {};
  const settings: AssetImportSettings = {};
  if (isString(value.usage)) settings.usage = value.usage;
  if (isString(value.usageSource) && USAGE_SOURCES.has(value.usageSource)) {
    settings.usageSource = value.usageSource as TextureUsageSource;
  }
  return settings;
}

/** A source link as the lock writes it, or nothing when it has no URL. */
function sourceOf(value: unknown): AssetLockEntry["source"] {
  if (!(isJsonObject(value) && isString(value.url))) return undefined;
  const source: NonNullable<AssetLockEntry["source"]> = { url: value.url };
  if (isString(value.page)) source.page = value.page;
  if (Array.isArray(value.authors)) source.authors = value.authors.filter(isString);
  return source;
}

/** The outputs as the lock writes them: well-formed ones only, sorted by file then family. */
function outputsOf(value: unknown): AssetLockOutput[] {
  if (!Array.isArray(value)) return [];
  const outputs: AssetLockOutput[] = [];
  for (const item of value) {
    if (!(isJsonObject(item) && isLockPath(item.file) && isSha256(item.sha256) && isCount(item.bytes))) continue;
    const family = isString(item.family) ? { family: item.family } : {};
    outputs.push({ file: item.file, ...family, sha256: item.sha256, bytes: item.bytes });
  }
  return outputs.sort((a, b) => byText(a.file, b.file) || byText(a.family ?? "", b.family ?? ""));
}

/** The issues as the lock writes them: known codes only, each once, sorted. */
function issuesOf(value: unknown): ImportIssue[] {
  if (!Array.isArray(value)) return [];
  const seen = new Map<string, ImportIssue>();
  for (const item of value) {
    if (!(isJsonObject(item) && isString(item.code) && ISSUE_CODES.has(item.code))) continue;
    const issue: ImportIssue = { code: item.code as ImportIssueCode };
    if (isString(item.detail)) issue.detail = item.detail;
    seen.set(`${issue.code}\u0000${issue.detail ?? ""}`, issue);
  }
  return [...seen.entries()].sort(([a], [b]) => byText(a, b)).map(([, issue]) => issue);
}

/** One row in the lock's key order; fields that fail their shape fall back to their defaults. */
function entryOf(id: string, file: string, sha256: string, raw: Record<string, unknown>): AssetLockEntry {
  const source = sourceOf(raw.source);
  return {
    id,
    path: file,
    sha256,
    kind: isString(raw.kind) && KINDS.has(raw.kind) ? (raw.kind as AssetKind) : assetKind(file),
    origin: isString(raw.origin) && ORIGINS.has(raw.origin) ? (raw.origin as AssetOrigin) : AssetOrigin.Person,
    licence: isString(raw.licence) && LICENCES.has(raw.licence) ? (raw.licence as AssetLicence) : AssetLicence.Unknown,
    ...(source ? { source } : {}),
    settings: settingsOf(raw.settings),
    importer: isString(raw.importer) ? raw.importer : "",
    deps: Array.isArray(raw.deps) ? [...new Set(raw.deps.filter(isString))].sort(byText) : [],
    outputs: outputsOf(raw.outputs),
    issues: issuesOf(raw.issues),
  };
}

/** The well-formed rows of a parsed lock, each id and path once; the rest by path in `ignored`. */
function readEntries(raw: unknown): { entries: AssetLockEntry[]; ignored: string[] } {
  const entries: AssetLockEntry[] = [];
  const ignored: string[] = [];
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const row of Array.isArray(raw) ? raw : []) {
    if (!isJsonObject(row)) continue;
    const { id, path: file, sha256 } = row;
    const wellFormed = isString(id) && ID_PATTERN.test(id) && isLockPath(file) && isSha256(sha256);
    if (!wellFormed || ids.has(id) || paths.has(file)) {
      ignored.push(isString(file) ? file : "");
      continue;
    }
    ids.add(id);
    paths.add(file);
    entries.push(entryOf(id, file, sha256, row));
  }
  return { entries, ignored };
}

/** A derived row in the lock's key order, or null when it is malformed. */
function derivedOf(raw: unknown): AssetLockDerived | null {
  if (!isJsonObject(raw)) return null;
  const { kind, name, inputs, params, sha256, bytes } = raw;
  const kindOk = isString(kind) && BAKE_KINDS.has(kind);
  const shapeOk = isBakeName(name) && Array.isArray(inputs) && isString(params) && isSha256(sha256) && isCount(bytes);
  if (!(kindOk && shapeOk)) return null;
  const ids = [...new Set(inputs.filter((id): id is string => isString(id) && ID_PATTERN.test(id)))].sort(byText);
  return { kind: kind as BakeKind, name, inputs: ids, params, sha256, bytes };
}

/** Derived rows sorted by kind then name, the last of a kind and name winning. */
function sortDerived(rows: readonly AssetLockDerived[]): AssetLockDerived[] {
  const byKey = new Map<string, AssetLockDerived>();
  for (const row of rows) byKey.set(`${row.kind}\u0000${row.name}`, row);
  return [...byKey.entries()].sort(([a], [b]) => byText(a, b)).map(([, row]) => row);
}

const emptyRead = (state: AssetLockState, text: string | null): AssetLockRead => ({
  state,
  text,
  entries: [],
  derived: [],
  ignored: [],
});

/**
 * The lock's text read for what it can still be trusted with: null text is a missing lock. Rows
 * are shape-checked whatever the digest says (anyone can recompute it), so a hostile row is
 * dropped even from a lock whose digest matches.
 */
export function parseAssetLock(text: string | null): AssetLockRead {
  if (text === null) return emptyRead(AssetLockState.Missing, null);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return emptyRead(AssetLockState.Edited, text);
  }
  if (!isJsonObject(raw)) return emptyRead(AssetLockState.Edited, text);
  if (raw.version !== ASSET_LOCK_VERSION) return emptyRead(AssetLockState.OtherVersion, text);
  const { entries, ignored } = readEntries(raw.entries);
  const derived = sortDerived((Array.isArray(raw.derived) ? raw.derived : []).map(derivedOf).filter((d) => d !== null));
  const trusted = raw.digest === bodyDigest(raw.version, raw.entries, raw.derived);
  return { state: trusted ? AssetLockState.Trusted : AssetLockState.Edited, text, entries, derived, ignored };
}

/** The lock beside `genex.toml` in `gameDir`: never read through a link, a FIFO or past its cap. */
export async function readAssetLock(gameDir: string): Promise<AssetLockRead> {
  const file = path.join(await realpath(gameDir), ASSET_LOCK_FILE);
  try {
    return parseAssetLock((await readRegularFile(file, LOCK_MAX_BYTES)).toString("utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return parseAssetLock(null);
    if (error instanceof NotARegularFileError || (error as NodeJS.ErrnoException).code === "ELOOP") {
      return emptyRead(AssetLockState.Edited, null);
    }
    throw error;
  }
}

/** A fresh random id. */
function randomId(): string {
  return randomBytes(ID_BYTES).toString("hex");
}

/** An id `taken` does not hold yet, from `newId`. */
function mintId(newId: () => string, taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 64; attempt++) {
    const id = newId();
    if (ID_PATTERN.test(id) && !taken.has(id)) return id;
  }
  throw new Error(MESSAGE.IdsExhausted);
}

/** The well-formed facts, each path once, in path order. */
function sortedFacts(facts: readonly AssetLockFacts[]): AssetLockFacts[] {
  const byPath = new Map<string, AssetLockFacts>();
  for (const fact of facts) {
    if (isLockPath(fact.path) && isSha256(fact.sha256) && !byPath.has(fact.path)) byPath.set(fact.path, fact);
  }
  return [...byPath.values()].sort((a, b) => byText(a.path, b.path));
}

/**
 * The old row each fact keeps its id from. A trusted lock gives a fact the row at its own path,
 * or else a vanished row with its sha256 (a rename), claimed in path order. An edited lock only
 * gives a row whose path and sha256 both match, so an edit can neither move an id nor forge one.
 */
function matchRows(read: AssetLockRead, facts: readonly AssetLockFacts[]): Map<string, AssetLockEntry> {
  const matched = new Map<string, AssetLockEntry>();
  const byPath = new Map(read.entries.map((row) => [row.path, row]));
  const trusted = read.state === AssetLockState.Trusted;
  const unmatched: AssetLockFacts[] = [];
  for (const fact of facts) {
    const row = byPath.get(fact.path);
    if (row && (trusted || row.sha256 === fact.sha256)) matched.set(fact.path, row);
    else unmatched.push(fact);
  }
  if (!trusted) return matched;
  const present = new Set(facts.map((fact) => fact.path));
  const vanished = read.entries.filter((row) => !present.has(row.path));
  for (const fact of unmatched) {
    const at = vanished.findIndex((row) => row.sha256 === fact.sha256);
    if (at < 0) continue;
    matched.set(fact.path, vanished[at] as AssetLockEntry);
    vanished.splice(at, 1);
  }
  return matched;
}

/** One fact's row: its facts first, then what the trusted old row carried, then the defaults. */
function rowFor(fact: AssetLockFacts, id: string, old: AssetLockEntry | undefined): AssetLockEntry {
  const carried: Partial<AssetLockEntry> = old ?? {};
  return entryOf(id, fact.path, fact.sha256, {
    kind: fact.kind,
    origin: fact.origin ?? carried.origin,
    licence: fact.licence ?? carried.licence,
    source: fact.source ?? carried.source,
    settings: fact.settings ?? carried.settings,
    importer: fact.importer ?? carried.importer,
    deps: [],
    outputs: fact.outputs ?? carried.outputs,
    issues: fact.issues ?? carried.issues,
  });
}

/**
 * The lock the facts describe, given what the old lock still can be trusted with: rows in path
 * order, deps as ids, derived rows kept (from a trusted lock only) while all their inputs remain.
 * Pure; `newId` mints the id of a source seen for the first time.
 */
export function resolveAssetLock(
  read: AssetLockRead,
  facts: readonly AssetLockFacts[],
  { newId = randomId }: ResolveOptions = {},
): AssetLockResolution {
  const trusted = read.state === AssetLockState.Trusted;
  const sorted = sortedFacts(facts);
  const matched = matchRows(read, sorted);
  const taken = new Set([...matched.values()].map((row) => row.id));
  const entries = sorted.map((fact) => {
    const old = matched.get(fact.path);
    const id = old?.id ?? mintId(newId, taken);
    taken.add(id);
    return rowFor(fact, id, trusted ? old : undefined);
  });
  const ids = new Set(entries.map((row) => row.id));
  const idByPath = new Map(entries.map((row) => [row.path, row.id]));
  sorted.forEach((fact, at) => {
    const carried = trusted ? (matched.get(fact.path)?.deps ?? []) : [];
    const named = fact.deps?.map((dep) => idByPath.get(dep)) ?? carried;
    const deps = named.filter((id): id is string => id !== undefined && ids.has(id));
    (entries[at] as AssetLockEntry).deps = [...new Set(deps)].sort(byText);
  });
  const derived = trusted ? read.derived.filter((row) => row.inputs.every((id) => ids.has(id))) : [];
  const issues = read.state === AssetLockState.Edited ? [{ code: ImportIssueCode.LockEdited }] : [];
  return { lock: { version: ASSET_LOCK_VERSION, entries, derived }, issues };
}

/**
 * The lock with one bake recorded (NAV-14b, LOD bakes): it replaces the row of the same kind and
 * name. Throws on a malformed row or an input id the lock does not hold.
 */
export function withDerived(lock: AssetLock, row: AssetLockDerived): AssetLock {
  const checked = derivedOf(row);
  if (!checked) throw new Error(MESSAGE.BadDerived);
  const ids = new Set(lock.entries.map((entry) => entry.id));
  const unknown = row.inputs.find((id) => !ids.has(id));
  if (unknown !== undefined) throw new Error(MESSAGE.UnknownInput(unknown));
  return { ...lock, derived: sortDerived([...lock.derived, checked]) };
}

/**
 * Write the lock beside `genex.toml` when its text changed: atomically, replacing (never writing
 * through) a link planted at its name. True when it wrote.
 */
export async function writeAssetLock(gameDir: string, lock: AssetLock, previous: string | null): Promise<boolean> {
  const text = serializeAssetLock(lock);
  if (text === previous) return false;
  await atomicWriteText(path.join(await realpath(gameDir), ASSET_LOCK_FILE), text);
  return true;
}

/**
 * Read the lock, resolve it against this import's facts and write it when it changed. The one
 * call the build lane makes after its import step.
 */
export async function refreshAssetLock(
  gameDir: string,
  facts: readonly AssetLockFacts[],
  options: ResolveOptions = {},
): Promise<AssetLockRefresh> {
  const read = await readAssetLock(gameDir);
  const resolution = resolveAssetLock(read, facts, options);
  const written = await writeAssetLock(gameDir, resolution.lock, read.text);
  return { ...resolution, written, ignored: read.ignored };
}

/**
 * The sha256 of one file inside the game, or null when `rel` is not a plain relative path, is a
 * link (at any folder on the way), is not a regular file or is missing. Streams, so a large model
 * is never held whole.
 */
export async function hashGameFile(gameDir: string, rel: string): Promise<string | null> {
  if (!isLockPath(rel)) return null;
  const root = await realpath(gameDir).catch(() => null);
  if (!root) return null;
  const target = path.join(root, ...rel.split("/"));
  const info = await lstat(target).catch(() => null);
  if (!info?.isFile()) return null;
  if ((await realpath(target).catch(() => null)) !== target) return null;
  const handle = await openNoFollow(target, FS.O_RDONLY | FS.O_NONBLOCK).catch(() => null);
  if (!handle) return null;
  try {
    if (!(await handle.stat()).isFile()) return null;
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

/**
 * The lock facts of an asset walk's files (`walkGameAssets`, which never lists a link): each
 * hashed through `hash`, its kind from the format table. A file that cannot be hashed is left out.
 */
export async function hashAssetEntries(
  gameDir: string,
  entries: readonly AssetEntry[],
  hash: (gameDir: string, rel: string) => Promise<string | null> = hashGameFile,
): Promise<AssetLockFacts[]> {
  const facts: AssetLockFacts[] = [];
  for (const entry of entries) {
    const sha256 = await hash(gameDir, entry.file);
    if (sha256) facts.push({ path: entry.file, sha256, kind: assetKind(entry.file) });
  }
  return facts;
}

/** The origin and licence the inventory's source (`joinProjectAssets`) gives a lock row. */
export function assetOriginOf(source: AssetSource): { origin: AssetOrigin; licence: AssetLicence } {
  switch (source) {
    case "genex":
      return { origin: AssetOrigin.Genex, licence: AssetLicence.Generated };
    case "blender":
      return { origin: AssetOrigin.Blender, licence: AssetLicence.Generated };
    case "imported":
      return { origin: AssetOrigin.Person, licence: AssetLicence.Unknown };
    default:
      return { origin: AssetOrigin.Delivered, licence: AssetLicence.Unknown };
  }
}
