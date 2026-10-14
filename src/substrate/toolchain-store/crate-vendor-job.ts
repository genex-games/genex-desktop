/**
 * The crate request flow's offline half (extension ladder level 4): resolving a requested crate's
 * closure from a registry index, fetching each archive through the host's verified download cache
 * (named by the sha256 the index lists), and the vendor job that vets the closure with no network.
 *
 * Resolution reads the sparse index (crates.io's JSON lines: `name`, `vers`, `deps`, `cksum`,
 * `features`, `yanked`) the way cargo's resolver picks one version per crate: the newest release
 * a requirement accepts, never a yanked one, with the features the dependents and the defaults
 * turn on (`dep:x`, `x/feature` and `x?/feature` included). Development dependencies never enter
 * a closure; every platform's dependencies do, as a lock holds them all. A crate the store's lock
 * line already vendors is reused at its locked version, and a requirement that version does not
 * meet would add a second copy (`crate-duplicate-version`).
 *
 * The vendor job runs in-process on the host with no socket and no write outside its job folder:
 * it extracts each archive with the store's archive reader (every entry checked before anything
 * is written), reads each crate's normalized `Cargo.toml` as data, writes cargo's
 * `.cargo-checksum.json` for a directory source, and asks the crate checker (`crate-check.ts`:
 * cargo-deny and cargo-vet in their own sandbox, or the built-in rules in a fixture profile) about
 * the closure: the pinned advisory snapshot (`crate-advisory`), the allowed licences
 * (`crate-licence`) and the bans (`crate-banned`) refuse it; the trusted sources' audits are only
 * reported. Then build scripts and proc macros, each refused unless the person approved that kind
 * separately (`crate-build-script`, `crate-proc-macro`).
 */
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { type CrateCheckReport, CrateRefusal } from "../../shared/crate-requests.ts";
import { errorMessage } from "../../shared/errors.ts";
import { ArchiveFormat } from "../../shared/toolchain.ts";
import { readRegularFile } from "../fsx.ts";
import { GAME_CRATE_ALLOWLIST } from "../genex-toml.ts";
import { extractArchive, listArchive, treeDigest } from "./archive.ts";
import type { CrateChecker } from "./crate-check.ts";
import { cachedDownload, cacheEntryPath, verifiedCacheEntry } from "./download-cache.ts";

/** A crate's registry name: a letter, then letters, digits, `-` and `_`, at most 64 in all. */
const CRATE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** A release version: three numbers, an optional pre-release and build suffix. */
const SEMVER = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]{1,40}))?(?:\+[0-9A-Za-z.-]{1,40})?$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** The most of one index file and of one crate manifest the host reads. */
const INDEX_MAX_BYTES = 16 * 1024 * 1024;
const MANIFEST_MAX_BYTES = 1024 * 1024;
/** The most one crate's archive may unpack to: a crate's sources, never a disk's worth. */
export const CRATE_UNPACKED_MAX_BYTES = 64 * 1024 * 1024;
/** The most a whole closure may unpack to. */
export const CLOSURE_UNPACKED_MAX_BYTES = 512 * 1024 * 1024;
/** The most entries one crate's archive may hold. */
const CRATE_ENTRIES_MAX = 20_000;
/** The most of a downloaded `.crate` the job reads (crates.io takes up to 10 MiB). */
const CRATE_ARCHIVE_READ_MAX_BYTES = 16 * 1024 * 1024;
/** The most crates one request may add: a request that pulls in more is a release change, not a request. */
export const CRATE_CLOSURE_MAX = 64;
/** cargo's per-crate checksum file in a directory source. */
const CHECKSUM_FILE = ".cargo-checksum.json";

const MESSAGE = {
  unpacksTooMuch: (cap: number) => `the archive unpacks to more than ${cap} bytes, or holds too many files`,
  notFound: (name: string, req: string) => `no release of ${name} matches ${req}`,
  yanked: (name: string, version: string) => `${name} ${version} was yanked`,
  engineCrate: (name: string) =>
    `${name} is one of the engine's own crates: a game reaches it through the genex facade`,
  duplicate: (name: string, locked: string, req: string) =>
    `${name} ${locked} is already vendored and does not match ${req}: a second version`,
  tooLarge: (count: number) => `the closure adds more than ${count} crates`,
  checksum: (name: string, version: string) => `${name} ${version} does not match the index's sha256`,
  archive: (name: string, version: string, why: string) => `${name} ${version}: ${why}`,
  buildScript: (names: readonly string[]) => `${names.join(", ")} run a build script`,
  licenceUnread: (name: string, version: string, field: string) =>
    `${name} ${version} names a ${field} Genex cannot read as its own: refused before any check`,
  procMacro: (names: readonly string[]) =>
    `${names.join(", ")} ${names.length === 1 ? "is a proc macro" : "are proc macros"}`,
} as const;

/** A typed refusal with a short detail naming the crate (never a host path). */
export interface CrateRefused {
  ok: false;
  refusal: CrateRefusal;
  detail: string;
}

const refuse = (refusal: CrateRefusal, detail: string): CrateRefused => ({ ok: false, refusal, detail });

// ── The index ───────────────────────────────────────────────────────────────────────────────────

/** One dependency of an index entry, as the sparse index spells it. */
export interface CrateIndexDep {
  /** The name the dependent calls it by (a rename when `package` is set). */
  name: string;
  req: string;
  features: readonly string[];
  optional: boolean;
  default_features: boolean;
  target: string | null;
  kind: "normal" | "build" | "dev" | null;
  /** The crate's registry name when the dependency is renamed. */
  package?: string;
}

/** One version of a crate in the sparse index. */
export interface CrateIndexEntry {
  name: string;
  vers: string;
  deps: readonly CrateIndexDep[];
  cksum: string;
  features: Readonly<Record<string, readonly string[]>>;
  features2?: Readonly<Record<string, readonly string[]>>;
  yanked: boolean;
}

/** A registry's index: every version of a crate, or null when the registry has none by that name. */
export interface CrateIndex {
  versions(name: string): Promise<readonly CrateIndexEntry[] | null>;
}

/** Whether `name` is a crate name the host joins into a path or a URL. */
export function isCrateName(name: unknown): name is string {
  return typeof name === "string" && CRATE_NAME.test(name);
}

/** Whether `version` is one exact release version. */
export function isCrateVersion(version: unknown): version is string {
  return typeof version === "string" && SEMVER.test(version);
}

/** The sparse index's path of a crate: `1/a`, `2/ab`, `3/a/abc`, `ab/cd/abcd…`, lowercased. */
export function sparseIndexPath(name: string): string {
  const lower = name.toLowerCase();
  if (lower.length <= 2) return `${lower.length}/${lower}`;
  if (lower.length === 3) return `3/${lower[0]}/${lower}`;
  return `${lower.slice(0, 2)}/${lower.slice(2, 4)}/${lower}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

function featureTable(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([name, list]) => [name, strings(list)]));
}

function indexDep(value: unknown): CrateIndexDep | null {
  if (!isRecord(value) || !isCrateName(value.name) || typeof value.req !== "string") return null;
  const kind = value.kind === "build" || value.kind === "dev" ? value.kind : "normal";
  const renamed = isCrateName(value.package) ? { package: value.package } : {};
  return {
    name: value.name,
    req: value.req,
    features: strings(value.features),
    optional: value.optional === true,
    default_features: value.default_features !== false,
    target: typeof value.target === "string" ? value.target : null,
    kind,
    ...renamed,
  };
}

/** The entries of one sparse-index file; a line that is not an entry of `name` is skipped. */
export function parseIndexLines(name: string, text: string): CrateIndexEntry[] {
  const entries: CrateIndexEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(value) || value.name !== name || !isCrateVersion(value.vers)) continue;
    if (typeof value.cksum !== "string" || !SHA256.test(value.cksum)) continue;
    const deps = Array.isArray(value.deps) ? value.deps.map(indexDep) : [];
    if (deps.some((dep) => dep === null)) continue;
    entries.push({
      name,
      vers: value.vers,
      deps: deps.filter((dep) => dep !== null),
      cksum: value.cksum,
      features: featureTable(value.features),
      features2: featureTable(value.features2),
      yanked: value.yanked === true,
    });
  }
  return entries;
}

/** An index read from a local mirror's `index/<name>` files (the fixture registry's layout). */
export function directoryCrateIndex(root: string): CrateIndex {
  return {
    versions: async (name) => {
      if (!isCrateName(name)) return null;
      const bytes = await readRegularFile(path.join(root, "index", name.toLowerCase()), INDEX_MAX_BYTES).catch(
        () => null,
      );
      return bytes === null ? null : parseIndexLines(name, bytes.toString("utf8"));
    },
  };
}

/** A download from a local mirror's `crates/<name>-<version>.crate` files. */
export function directoryCrateDownload(root: string): CrateDownload {
  return async (crate, file) => {
    await copyFile(path.join(root, "crates", `${crate.name}-${crate.version}.crate`), file);
  };
}

// ── Versions and requirements ──────────────────────────────────────────────────────────────────

interface Version {
  numbers: [number, number, number];
  pre: string | null;
}

function parseVersion(text: string): Version | null {
  const match = SEMVER.exec(text);
  if (!match) return null;
  return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? null };
}

function compareVersion(a: Version, b: Version): number {
  for (let at = 0; at < 3; at += 1) {
    const step = a.numbers[at] - b.numbers[at];
    if (step !== 0) return Math.sign(step);
  }
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  return a.pre < b.pre ? -1 : 1;
}

/** One comparator: the versions it accepts lie in `[low, high)`; an exact pre-release only when named. */
interface Comparator {
  low: Version | null;
  high: Version | null;
  /** A `>` comparator excludes `low` itself. */
  lowExclusive: boolean;
  /** A `<=` comparator includes `high` itself. */
  highInclusive: boolean;
  pre: Version | null;
}

const COMPARATOR = /^(=|>=|<=|>|<|~|\^)?\s*(\*|\d+)(?:\.(\*|x|X|\d+))?(?:\.(\*|x|X|\d+))?(?:-([0-9A-Za-z.-]+))?$/;
const WILD = new Set(["*", "x", "X"]);
const version3 = (major: number, minor: number, patch: number): Version => ({
  numbers: [major, minor, patch],
  pre: null,
});

/** The first version a caret, tilde or equality over the `given` parts refuses. */
function bumped(operator: string, given: readonly number[]): Version {
  let at = given.length - 1;
  if (operator === "~") at = Math.min(1, given.length - 1);
  if (operator === "^" || operator === "") {
    const nonZero = given.findIndex((part) => part !== 0);
    at = nonZero === -1 ? given.length - 1 : nonZero;
  }
  const parts = [0, 0, 0];
  for (let index = 0; index < at; index += 1) parts[index] = given[index] ?? 0;
  parts[at] = (given[at] ?? 0) + 1;
  return version3(parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0);
}

/** The range of an ordering comparator (`>=`, `>`, `<`, `<=`) over the `given` parts; null for any other operator. */
function orderingRange(
  operator: string,
  given: readonly number[],
  low: Version,
  pre: Version | null,
): Comparator | null {
  const full = given.length === 3;
  const none = { lowExclusive: false, highInclusive: false, pre };
  if (operator === ">=") return { low, high: null, ...none };
  if (operator === ">") return { low: full ? low : bumped("=", given), high: null, ...none, lowExclusive: full };
  if (operator === "<") return { low: null, high: low, ...none };
  if (operator === "<=") return { low: null, high: full ? low : bumped("=", given), ...none, highInclusive: full };
  return null;
}

function comparator(text: string): Comparator | null {
  const match = COMPARATOR.exec(text.trim());
  if (!match) return null;
  const operator = match[1] ?? "";
  const raw = [match[2], match[3], match[4]].filter((part) => part !== undefined);
  const wildAt = raw.findIndex((part) => WILD.has(part));
  const given = (wildAt === -1 ? raw : raw.slice(0, wildAt)).map(Number);
  const low = version3(given[0] ?? 0, given[1] ?? 0, given[2] ?? 0);
  const pre = match[5] !== undefined && given.length === 3 ? { numbers: low.numbers, pre: match[5] } : null;
  if (given.length === 0) return { low: null, high: null, lowExclusive: false, highInclusive: false, pre };
  const lowBound = pre ?? low;
  const ordered = orderingRange(operator, given, lowBound, pre);
  if (ordered) return ordered;
  const high = bumped(wildAt === -1 ? operator : "=", given);
  return { low: lowBound, high, lowExclusive: false, highInclusive: false, pre };
}

/** A requirement (`^1.2`, `~0.3`, `>=1, <2`, `=1.0.0`, `1.*`): every comparator must accept. Null when unreadable. */
export function parseRequirement(text: string): ((version: string) => boolean) | null {
  const comparators = text.split(",").map(comparator);
  if (comparators.some((found) => found === null)) return null;
  const all = comparators.filter((found) => found !== null);
  return (raw) => {
    const version = parseVersion(raw);
    if (!version) return false;
    return all.every((found) => accepts(found, version));
  };
}

function accepts(found: Comparator, version: Version): boolean {
  // A pre-release matches only a comparator naming a pre-release of the same release.
  const sameRelease = found.pre?.numbers.every((part, index) => part === version.numbers[index]) === true;
  if (version.pre !== null && !sameRelease) return false;
  if (found.low) {
    const order = compareVersion(version, found.low);
    if (order < 0 || (order === 0 && found.lowExclusive)) return false;
  }
  if (found.high) {
    const order = compareVersion(version, found.high);
    if (order > 0 || (order === 0 && !found.highInclusive)) return false;
  }
  return true;
}

// ── The closure ────────────────────────────────────────────────────────────────────────────────

/** A crate at one version. */
export interface CrateId {
  name: string;
  version: string;
}

/** One crate the closure adds (not already vendored by the store), with its index sha256. */
export interface ClosureCrate extends CrateId {
  cksum: string;
}

/** The crates a request adds, sorted by name; or why it cannot be had. */
export type CrateClosure = { ok: true; crates: ClosureCrate[] } | CrateRefused;

/** The key a crate is found by in the overlay and the closure: `name@version`. */
export function crateId(crate: CrateId): string {
  return `${crate.name}@${crate.version}`;
}

/** One selected crate and the features turned on in it so far. */
interface Selected {
  entry: CrateIndexEntry;
  /** Whether its dependencies were activated at least once. */
  walked: boolean;
  features: Set<string>;
  /** Optional dependencies (by their dependent-side name) turned on. */
  optional: Set<string>;
  /** `dep?/feature` rows waiting on their dependency. */
  weak: Map<string, Set<string>>;
  /** `dep/feature` rows: features turned on in a dependency. */
  depFeatures: Map<string, Set<string>>;
}

/** A request to activate `name` under `req` with features, from a dependent. */
interface Activation {
  name: string;
  req: string;
  features: readonly string[];
  defaults: boolean;
}

/** Adds `value` to the set `key` names in `map`. */
function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
  map.set(key, (map.get(key) ?? new Set()).add(value));
}

/** A `dep/feature` or `dep?/feature` row: the dependency's feature, turning an optional one on unless weak. */
function enableDependencyFeature(selected: Selected, row: string, optionalNames: ReadonlySet<string>): void {
  const slash = row.indexOf("/");
  const weak = row[slash - 1] === "?";
  const depName = row.slice(0, weak ? slash - 1 : slash);
  const depFeature = row.slice(slash + 1);
  if (weak) {
    addTo(selected.weak, depName, depFeature);
    return;
  }
  if (optionalNames.has(depName)) selected.optional.add(depName);
  addTo(selected.depFeatures, depName, depFeature);
}

/** Turns on `feature` in `selected`, following the feature table to fixpoint. */
function enableFeature(selected: Selected, feature: string): void {
  const table = { ...selected.entry.features, ...selected.entry.features2 };
  const pending = [feature];
  const optionalNames = new Set(selected.entry.deps.filter((dep) => dep.optional).map((dep) => dep.name));
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (next.startsWith("dep:")) selected.optional.add(next.slice(4));
    else if (next.indexOf("/") > 0) enableDependencyFeature(selected, next, optionalNames);
    else if (!selected.features.has(next)) enableNamed(selected, next, table, optionalNames, pending);
  }
}

/** Turns on a plain feature: its table row's entries follow; a feature named like an optional dependency turns it on. */
function enableNamed(
  selected: Selected,
  next: string,
  table: Readonly<Record<string, readonly string[]>>,
  optionalNames: ReadonlySet<string>,
  pending: string[],
): void {
  selected.features.add(next);
  const listed = table[next];
  if (listed) pending.push(...listed);
  // An optional dependency is also a feature of its own name unless `dep:` hides it.
  else if (optionalNames.has(next)) selected.optional.add(next);
}

/** The activations a selected crate makes of its dependencies with its current features. */
function activationsOf(selected: Selected): Activation[] {
  const found: Activation[] = [];
  for (const dep of selected.entry.deps) {
    if (dep.kind === "dev") continue;
    if (dep.optional && !selected.optional.has(dep.name)) continue;
    const weak = selected.weak.get(dep.name) ?? new Set<string>();
    const features = [...dep.features, ...(selected.depFeatures.get(dep.name) ?? []), ...weak];
    found.push({ name: dep.package ?? dep.name, req: dep.req, features, defaults: dep.default_features });
  }
  return found;
}

/** The newest release of `name` that `req` accepts and is not yanked; null when there is none. */
function newestAccepted(
  entries: readonly CrateIndexEntry[],
  req: (version: string) => boolean,
): CrateIndexEntry | null {
  const accepted = entries.filter((entry) => !entry.yanked && req(entry.vers));
  const versions = accepted.map((entry) => ({ entry, version: parseVersion(entry.vers) }));
  versions.sort((a, b) => (a.version && b.version ? compareVersion(b.version, a.version) : 0));
  return versions[0]?.entry ?? null;
}

/** What resolution keeps while it walks: the index, the store's locked crates, the selections. */
interface Walk {
  index: CrateIndex;
  locked: ReadonlyMap<string, string>;
  selected: Map<string, Selected>;
  queue: string[];
}

/** How much a selection turns on: features, optional dependencies and dependency features, counted. */
function growth(selected: Selected): number {
  let count = selected.features.size + selected.optional.size;
  for (const set of [...selected.weak.values(), ...selected.depFeatures.values()]) count += set.size;
  return count;
}

/** The crate an activation names, already selected or newly chosen; the refusal when there is none it may be. */
async function selectionFor(
  walk: Walk,
  activation: Activation,
  req: (version: string) => boolean,
): Promise<Selected | CrateRefused> {
  const known = walk.selected.get(activation.name);
  if (known && !req(known.entry.vers)) {
    return refuse(CrateRefusal.DuplicateVersion, MESSAGE.duplicate(activation.name, known.entry.vers, activation.req));
  }
  if (known) return known;
  const entry = newestAccepted((await walk.index.versions(activation.name)) ?? [], req);
  if (!entry) return refuse(CrateRefusal.NotFound, MESSAGE.notFound(activation.name, activation.req));
  const selected: Selected = {
    entry,
    walked: false,
    features: new Set(),
    optional: new Set(),
    weak: new Map(),
    depFeatures: new Map(),
  };
  walk.selected.set(activation.name, selected);
  return selected;
}

/** Selects (or reuses) the crate an activation names, merging its features; a refusal when it cannot. */
async function activate(walk: Walk, activation: Activation): Promise<CrateRefused | null> {
  const req = parseRequirement(activation.req);
  if (req === null) return refuse(CrateRefusal.NotFound, MESSAGE.notFound(activation.name, activation.req));
  const locked = walk.locked.get(activation.name);
  if (locked !== undefined) {
    if (req(locked)) return null;
    return refuse(CrateRefusal.DuplicateVersion, MESSAGE.duplicate(activation.name, locked, activation.req));
  }
  const selected = await selectionFor(walk, activation, req);
  if ("ok" in selected) return selected;
  const before = growth(selected);
  const wanted = [
    ...activation.features,
    ...(activation.defaults && selected.entry.features.default ? ["default"] : []),
  ];
  for (const feature of wanted) enableFeature(selected, feature);
  // Walked again only when what it turns on grew: a cycle of featureless crates ends.
  const fresh = !selected.walked || growth(selected) !== before;
  if (fresh && !walk.queue.includes(activation.name)) walk.queue.push(activation.name);
  return null;
}

/**
 * Why the requested crate itself cannot be had, or whether the store vendors it already; null to
 * resolve it. A crate the store's lock holds for the engine (off the reviewed list) is refused
 * `crate-engine-internal` whatever its version, so a request never opens the engine's crates.
 */
async function rootRefusal(
  index: CrateIndex,
  root: CrateId,
  locked: ReadonlyMap<string, string>,
): Promise<CrateClosure | null> {
  if (!isCrateName(root.name) || !isCrateVersion(root.version)) {
    return refuse(CrateRefusal.NotFound, MESSAGE.notFound(String(root.name), String(root.version)));
  }
  const entry = ((await index.versions(root.name)) ?? []).find((found) => found.vers === root.version);
  if (!entry) return refuse(CrateRefusal.NotFound, MESSAGE.notFound(root.name, `=${root.version}`));
  if (entry.yanked) return refuse(CrateRefusal.Yanked, MESSAGE.yanked(root.name, root.version));
  const vendored = locked.get(root.name);
  if (vendored === undefined) return null;
  // The store vendors it for the engine: a direct dependency on it would step around the facade.
  if (!GAME_CRATE_ALLOWLIST.includes(root.name))
    return refuse(CrateRefusal.EngineCrate, MESSAGE.engineCrate(root.name));
  if (vendored === root.version) return { ok: true, crates: [] };
  return refuse(CrateRefusal.DuplicateVersion, MESSAGE.duplicate(root.name, vendored, `=${root.version}`));
}

/**
 * The crates a request for `root` adds over the store's `locked` crates: every non-development
 * dependency, transitively, at one version each, with features followed. A refusal names the
 * first crate that cannot be had: `crate-not-found`, `crate-yanked` (the requested version
 * itself), `crate-duplicate-version`, or `crate-not-found` for a closure over
 * {@link CRATE_CLOSURE_MAX} crates.
 */
export async function resolveCrateClosure(
  index: CrateIndex,
  root: CrateId,
  locked: readonly CrateId[],
): Promise<CrateClosure> {
  const walk: Walk = {
    index,
    locked: new Map(locked.map((crate) => [crate.name, crate.version])),
    selected: new Map(),
    queue: [],
  };
  const settled = await rootRefusal(index, root, walk.locked);
  if (settled) return settled;
  const first = await activate(walk, { name: root.name, req: `=${root.version}`, features: [], defaults: true });
  if (first) return first;
  for (let next = walk.queue.shift(); next !== undefined; next = walk.queue.shift()) {
    const selected = walk.selected.get(next);
    if (!selected) continue;
    selected.walked = true;
    for (const activation of activationsOf(selected)) {
      const refused = await activate(walk, activation);
      if (refused) return refused;
    }
    if (walk.selected.size > CRATE_CLOSURE_MAX)
      return refuse(CrateRefusal.NotFound, MESSAGE.tooLarge(CRATE_CLOSURE_MAX));
  }
  const crates = [...walk.selected.values()]
    .map(({ entry: chosen }) => ({ name: chosen.name, version: chosen.vers, cksum: chosen.cksum }))
    .sort((a, b) => (a.name < b.name ? -1 : Number(a.name > b.name)));
  return { ok: true, crates };
}

// ── Fetching through the download cache ────────────────────────────────────────────────────────

/** Writes the `.crate` archive of `crate` at `file` (the host's network, or a local mirror). */
export type CrateDownload = (crate: CrateId, file: string) => Promise<void>;

/** The sha256 and size of the file at `file`. */
async function fileFacts(file: string): Promise<{ sha256: string; bytes: number }> {
  const bytes = await readRegularFile(file, CRATE_ARCHIVE_READ_MAX_BYTES);
  return { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

/** The cache's archive record for a crate of known size. */
function crateArchive(crate: ClosureCrate, bytes: number) {
  const url = `crate:${crateId(crate)}`;
  return { url, bytes, sha256: crate.cksum, format: ArchiveFormat.TarGz, strip: 1, into: "" };
}

/**
 * The verified cached archive of `crate`: the cache's entry when it is there and still matches
 * the index's sha256; otherwise downloaded into `scratch`, checked against that sha256, and only
 * then linked into the cache (`cachedDownload`). Bytes the index does not name are refused
 * `crate-overlay-tampered` and never cached.
 */
export async function cachedCrateArchive(
  cache: string,
  crate: ClosureCrate,
  download: CrateDownload,
  scratch: string,
): Promise<{ ok: true; file: string } | CrateRefused> {
  const entry = cacheEntryPath(cache, crate.cksum);
  const present = await lstat(entry).catch(() => null);
  if (present?.isFile()) {
    const hit = await verifiedCacheEntry(cache, crateArchive(crate, present.size));
    if (hit) return { ok: true, file: hit };
  }
  await mkdir(scratch, { recursive: true });
  const incoming = path.join(scratch, `${crate.name}-${crate.version}.crate`);
  try {
    await download(crate, incoming);
    const facts = await fileFacts(incoming);
    if (facts.sha256 !== crate.cksum)
      return refuse(CrateRefusal.OverlayTampered, MESSAGE.checksum(crate.name, crate.version));
    const cached = await cachedDownload(cache, crateArchive(crate, facts.bytes), (file) => copyFile(incoming, file));
    return { ok: true, file: cached.file };
  } finally {
    await rm(incoming, { force: true });
  }
}

// ── The vendor job ─────────────────────────────────────────────────────────────────────────────

/** The person's separate approvals: build scripts and proc macros are each refused without theirs. */
export interface CrateApprovals {
  buildScripts: boolean;
  procMacros: boolean;
}

/** One crate the job extracted and read. */
export interface VettedCrate extends ClosureCrate {
  /** The `license` expression, or `see <file>` for a `license-file`; null when it names none. */
  licence: string | null;
  /** The `license` expression alone; null when the manifest names none. */
  licenseExpression: string | null;
  /** The `license-file` the manifest names, relative to the crate; null when none. */
  licenseFile: string | null;
  buildScript: boolean;
  procMacro: boolean;
  /** Its folder in the job folder: `<jobDir>/<name>-<version>`. */
  dir: string;
  /** Its tree digest (`treeDigest`) with cargo's checksum file in place. */
  digest: string;
}

/** What the person is shown about a closure, known once it is extracted. */
export interface ClosureFacts {
  /** The requested crate's licence expression. */
  licence: string | null;
  closureSize: number;
  buildScripts: boolean;
  procMacros: boolean;
}

/** What the vendor job answers: the vetted closure, or the first refusal, each with the facts read and the checker's report. */
export type VendorJobResult =
  | { ok: true; crates: VettedCrate[]; facts: ClosureFacts; check: CrateCheckReport }
  | (CrateRefused & { facts: ClosureFacts | null; check: CrateCheckReport | null });

/** One crate of the job's input: what it is and where its verified archive lies. */
export interface VendorJobCrate extends ClosureCrate {
  archive: string;
}

/** The vendor job's input. */
export interface VendorJobInput {
  /** The job's own folder: the only place it writes. Made fresh. */
  jobDir: string;
  /** The requested crate (first in the facts). */
  root: CrateId;
  crates: readonly VendorJobCrate[];
  approvals: CrateApprovals;
  /** The engine that judges the closure's advisories, licences, bans and audits. */
  checker: CrateChecker;
  signal?: AbortSignal;
  /** The unpack caps (tests make them small): per crate, and over the whole closure. */
  limits?: { crateBytes: number; closureBytes: number };
}

/** `key = "value"` or `key = value` in one table's body, unquoted; null when absent. */
function tableField(body: string, key: string): string | null {
  const match = new RegExp(
    `^${key.replace(/-/g, "[-_]")}\\s*=\\s*(?:"([^"\\\\]*)"|([A-Za-z0-9_.-]+))\\s*(?:#.*)?$`,
    "m",
  ).exec(body);
  if (!match) return null;
  return match[1] ?? match[2] ?? null;
}

/** The body of the one-word table `[name]` in a normalized manifest: its lines up to the next header. */
function tableBody(manifest: string, name: string): string | null {
  const header = new RegExp(`^\\[${name}\\]\\s*$`, "m").exec(manifest);
  if (!header) return null;
  const rest = manifest.slice(header.index + header[0].length);
  const next = /^\[/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** Whether `[package]`'s body names `key` in any spelling a TOML reader takes (indented, quoted). */
function namesKey(body: string, key: string): boolean {
  const bare = key.replace(/-/g, "[-_]");
  return new RegExp(`^\\s*(?:${bare}|"${bare}"|'${bare}')\\s*=`, "m").test(body);
}

/**
 * Whether `rel` is the crate's own licence file: a relative path with no `..`, naming a regular
 * file (not a link) whose real path is inside the crate's folder `dir`.
 */
async function ownLicenceFile(dir: string, rel: string): Promise<boolean> {
  const segments = rel.split(/[\\/]/);
  if (path.isAbsolute(rel) || segments.some((segment) => segment === ".." || segment === "")) return false;
  const file = path.join(dir, rel);
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile()) return false;
  const [real, root] = await Promise.all([realpath(file), realpath(dir)]);
  return real.startsWith(`${root}${path.sep}`);
}

/**
 * The licence field a crate's `[package]` names that the host cannot take as read: a `license`
 * this reader cannot read (a literal string, an escape, an indented or quoted key), a
 * `license-file` likewise, or, when there is no expression, a `license-file` that is not the
 * crate's own regular file. Null when there is none. The checker then never judges a licence the
 * host read differently from cargo, nor a file outside the crate (a sibling's MIT text).
 */
async function licenceProblem(dir: string, pkg: string, license: string | null, licenseFile: string | null) {
  if (license === null && namesKey(pkg, "license")) return "license";
  if (licenseFile === null && namesKey(pkg, "license-file")) return "license-file";
  if (license === null && licenseFile !== null && !(await ownLicenceFile(dir, licenseFile))) return "license-file";
  return null;
}

/** What one crate's manifest and folder say: its licence, build script and proc-macro flags, and any licence field it hides. */
async function readCrate(dir: string): Promise<{
  licence: string | null;
  licenseExpression: string | null;
  licenseFile: string | null;
  buildScript: boolean;
  procMacro: boolean;
  /** The licence field the host cannot take as read (`licenceProblem`); null when there is none. */
  licenceUnread: string | null;
}> {
  const bytes = await readRegularFile(path.join(dir, "Cargo.toml"), MANIFEST_MAX_BYTES);
  const text = bytes.toString("utf8");
  // Multi-line strings (`description = """…"""`) cannot hide a field: their lines are dropped first.
  const manifest = text.replace(/"""[\s\S]*?"""/g, '""').replace(/'''[\s\S]*?'''/g, "''");
  const pkg = tableBody(manifest, "package") ?? "";
  const license = tableField(pkg, "license");
  const licenseFile = tableField(pkg, "license-file");
  const flags = crateManifestFlags(text);
  const hasBuildRs = (await lstat(path.join(dir, "build.rs")).catch(() => null)) !== null;
  // Cargo runs build.rs unless the manifest says `build = false`; any other `build` is a script.
  const buildScript = flags.build === null ? hasBuildRs : flags.build;
  const licence = license ?? (licenseFile === null ? null : `see ${licenseFile}`);
  const licenceUnread = await licenceProblem(dir, pkg, license, licenseFile);
  return { licence, licenseExpression: license, licenseFile, buildScript, procMacro: flags.procMacro, licenceUnread };
}

/**
 * What a crate's manifest says of the two things the person approves apart: `build` is true when
 * it names a build script in any spelling (a basic or literal string, a quoted, escaped or dotted
 * key, an inline table), false for `build = false` alone, null when it names none; `procMacro` is
 * true for `proc-macro`/`proc_macro` set to anything but `false`, or a `crate-type` naming
 * `proc-macro`. Nothing inside a string or a comment counts. A manifest this reader cannot read is
 * taken for both (fail closed): the person is asked about too much, never too little.
 */
export function crateManifestFlags(text: string): CrateManifestFlags {
  const tokens = manifestTokens(text);
  if (!tokens) return MANIFEST_FAIL_CLOSED;
  let build: boolean | null = null;
  let procMacro = false;
  for (let at = 0; at + 1 < tokens.length; at++) {
    const key = tokens[at];
    if (!key || key.kind === TokenKind.Punct || tokens[at + 1]?.text !== "=") continue;
    const value = tokens[at + 2];
    const isFalse = value?.kind === TokenKind.Word && value.text === "false";
    if (key.text === "build") build = build === true || !isFalse;
    if (PROC_MACRO_KEYS.has(key.text) && !isFalse) procMacro = true;
    if (CRATE_TYPE_KEYS.has(key.text) && namesProcMacro(tokens, at + 2)) procMacro = true;
  }
  return { build, procMacro };
}

/** A manifest's build-script and proc-macro flags (`crateManifestFlags`). */
export interface CrateManifestFlags {
  build: boolean | null;
  procMacro: boolean;
}

/** What a manifest this reader cannot read is taken for: both. */
const MANIFEST_FAIL_CLOSED: CrateManifestFlags = { build: true, procMacro: true };
/** The two spellings cargo takes for a proc-macro library. */
const PROC_MACRO_KEYS: ReadonlySet<string> = new Set(["proc-macro", "proc_macro"]);
const CRATE_TYPE_KEYS: ReadonlySet<string> = new Set(["crate-type", "crate_type"]);
/** The crate type that makes a library a proc macro. */
const PROC_MACRO_CRATE_TYPE = "proc-macro";

/** The kinds of token the manifest reader makes: a string's decoded text, a bare word, a punctuation mark. */
const TokenKind = { String: "string", Word: "word", Punct: "punct" } as const;
type TokenKind = (typeof TokenKind)[keyof typeof TokenKind];
interface ManifestToken {
  kind: TokenKind;
  text: string;
}

/** Whether the array value starting at `at` names the proc-macro crate type. */
function namesProcMacro(tokens: readonly ManifestToken[], at: number): boolean {
  if (tokens[at]?.text !== "[")
    return tokens[at]?.kind === TokenKind.String && tokens[at]?.text === PROC_MACRO_CRATE_TYPE;
  for (let next = at + 1; next < tokens.length && tokens[next]?.text !== "]"; next++) {
    const token = tokens[next];
    if (token?.kind === TokenKind.String && token.text === PROC_MACRO_CRATE_TYPE) return true;
  }
  return false;
}

/** The single-character escapes a TOML basic string takes, and what each stands for. */
const BASIC_ESCAPES: Readonly<Record<string, string>> = {
  b: "\b",
  t: "\t",
  n: "\n",
  f: "\f",
  r: "\r",
  '"': '"',
  "\\": "\\",
};
/** How many hex digits a `\u` or `\U` escape takes. */
const UNICODE_DIGITS: Readonly<Record<string, number>> = { u: 4, U: 8 };
const PUNCT = "=[]{},.";
const BARE = /[A-Za-z0-9_+:-]/;

/** One token read at a position, and where the reader goes on from; null when nothing can be read there. */
type TokenStep = { token: ManifestToken | null; end: number } | null;

/** Whitespace TOML skips between tokens. */
const isBlank = (char: string): boolean => char === " " || char === "\t" || char === "\n" || char === "\r";

/**
 * A manifest as tokens: strings decoded (basic, literal and both multi-line kinds), bare words,
 * punctuation; comments and whitespace dropped. Null for anything it cannot read: an unterminated
 * string, an escape TOML does not have, a control character, a character no token starts with.
 */
function manifestTokens(text: string): ManifestToken[] | null {
  const tokens: ManifestToken[] = [];
  let at = 0;
  while (at < text.length) {
    const step = tokenAt(text, at);
    if (!step) return null;
    if (step.token) tokens.push(step.token);
    at = step.end;
  }
  return tokens;
}

/** The token (or the blank or comment) at `at`, and where the next one starts. */
function tokenAt(text: string, at: number): TokenStep {
  const char = text[at] ?? "";
  if (isBlank(char)) return { token: null, end: at + 1 };
  if (char === "#") {
    const end = commentEnd(text, at);
    return end < 0 ? null : { token: null, end };
  }
  if (PUNCT.includes(char)) return { token: { kind: TokenKind.Punct, text: char }, end: at + 1 };
  if (char === '"' || char === "'") {
    const read = readString(text, at);
    return read ? { token: { kind: TokenKind.String, text: read.text }, end: read.end } : null;
  }
  if (!BARE.test(char)) return null;
  let end = at;
  while (end < text.length && BARE.test(text[end] ?? "")) end += 1;
  return { token: { kind: TokenKind.Word, text: text.slice(at, end) }, end };
}

/** Where the comment starting at `at` ends (its line's end); -1 for a control character inside. */
function commentEnd(text: string, at: number): number {
  let end = at;
  while (end < text.length && text[end] !== "\n") {
    const code = text.charCodeAt(end);
    if (code < 0x20 && code !== 0x09 && code !== 0x0d) return -1;
    end += 1;
  }
  return end;
}

/** Whether `char` may stand inside a string: a line break only in a multi-line one, no other control character. */
function allowedInString(char: string, multi: boolean): boolean {
  const lineBreak = char === "\n" || char === "\r";
  if (lineBreak) return multi;
  const code = char.charCodeAt(0);
  return code >= 0x20 || code === 0x09;
}

/** The string starting at `at` (any of TOML's four kinds), decoded, and where it ends; null when it cannot be read. */
function readString(text: string, at: number): { text: string; end: number } | null {
  const quote = text[at] ?? "";
  const multi = text.startsWith(quote.repeat(3), at);
  const open = multi ? 3 : 1;
  const close = quote.repeat(open);
  let out = "";
  let end = at + open;
  while (end < text.length) {
    if (text.startsWith(close, end)) return { text: out, end: end + open };
    const char = text[end] ?? "";
    if (!allowedInString(char, multi)) return null;
    const escaped = char === "\\" && quote === '"' ? basicEscape(text, end, multi) : { text: char, end: end + 1 };
    if (!escaped) return null;
    out += escaped.text;
    end = escaped.end;
  }
  return null;
}

/** One escape in a basic string at `at` (the backslash), decoded, and where it ends; null for one TOML lacks. */
function basicEscape(text: string, at: number, multi: boolean): { text: string; end: number } | null {
  const next = text[at + 1] ?? "";
  const simple = BASIC_ESCAPES[next];
  if (simple !== undefined) return { text: simple, end: at + 2 };
  const digits = UNICODE_DIGITS[next];
  if (digits !== undefined) return unicodeEscape(text, at + 2, digits);
  // A line-ending backslash in a multi-line basic string trims the break and the space after it.
  if (!multi || !/^[ \t]*\r?\n/.test(text.slice(at + 1))) return null;
  let end = at + 1;
  while (end < text.length && /\s/.test(text[end] ?? "")) end += 1;
  return { text: "", end };
}

/** The `digits` hex digits at `at` as one Unicode scalar value; null for anything else (a surrogate included). */
function unicodeEscape(text: string, at: number, digits: number): { text: string; end: number } | null {
  const hex = text.slice(at, at + digits);
  if (hex.length !== digits || !/^[0-9A-Fa-f]+$/.test(hex)) return null;
  const point = Number.parseInt(hex, 16);
  const surrogate = point >= 0xd800 && point <= 0xdfff;
  if (point > 0x10ffff || surrogate) return null;
  return { text: String.fromCodePoint(point), end: at + digits };
}

/** Every regular file under `root`, `/`-separated, sorted; a link or special file throws. */
async function filesUnder(root: string, rel = ""): Promise<string[]> {
  const at = rel ? path.join(root, ...rel.split("/")) : root;
  const found: string[] = [];
  for (const entry of await readdir(at, { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await filesUnder(root, child)));
    else if (entry.isFile()) found.push(child);
    else throw new Error(`${child} is not a regular file`);
  }
  return found.sort();
}

/** Writes cargo's `.cargo-checksum.json` for a directory source: each file's sha256 and the archive's. */
async function writeChecksums(dir: string, cksum: string): Promise<void> {
  const files: Record<string, string> = {};
  for (const rel of await filesUnder(dir)) {
    if (rel === CHECKSUM_FILE) continue;
    const bytes = await readRegularFile(path.join(dir, ...rel.split("/")), CRATE_UNPACKED_MAX_BYTES);
    files[rel] = createHash("sha256").update(bytes).digest("hex");
  }
  await writeFile(path.join(dir, CHECKSUM_FILE), JSON.stringify({ files, package: cksum }), { flag: "wx" });
}

/** The approvals' refusal of the vetted closure: build scripts, then proc macros; null when the person approved both kinds it has. */
function approvalRefusal(crates: readonly VettedCrate[], approvals: CrateApprovals): CrateRefused | null {
  const scripts = crates.filter((crate) => crate.buildScript).map((crate) => crate.name);
  if (scripts.length > 0 && !approvals.buildScripts)
    return refuse(CrateRefusal.BuildScript, MESSAGE.buildScript(scripts));
  const macros = crates.filter((crate) => crate.procMacro).map((crate) => crate.name);
  if (macros.length > 0 && !approvals.procMacros) return refuse(CrateRefusal.ProcMacro, MESSAGE.procMacro(macros));
  return null;
}

/**
 * What one crate's archive unpacks to, from its own headers before anything is written: refused
 * past the per-crate cap, the entry cap, or what is left of the closure's.
 */
async function unpackedBytes(input: VendorJobInput, crate: VendorJobCrate, left: number): Promise<number> {
  const entries = await listArchive(crate.archive, ArchiveFormat.TarGz, { signal: input.signal });
  const bytes = entries.reduce((total, entry) => total + Math.max(0, entry.size), 0);
  const cap = Math.min(input.limits?.crateBytes ?? CRATE_UNPACKED_MAX_BYTES, left);
  if (entries.length > CRATE_ENTRIES_MAX || bytes > cap) throw new Error(MESSAGE.unpacksTooMuch(cap));
  return bytes;
}

/** Extracts and reads one crate into the job folder; a refusal when its archive is unsafe or unreadable. */
async function extractCrate(
  input: VendorJobInput,
  crate: VendorJobCrate,
  left: number,
): Promise<(VettedCrate & { unpacked: number }) | CrateRefused> {
  const folder = `${crate.name}-${crate.version}`;
  const dir = path.join(input.jobDir, folder);
  try {
    const unpacked = await unpackedBytes(input, crate, left);
    await extractArchive(crate.archive, ArchiveFormat.TarGz, input.jobDir, {
      strip: 1,
      into: folder,
      signal: input.signal,
    });
    const { licenceUnread, ...read } = await readCrate(dir);
    if (licenceUnread !== null)
      return refuse(CrateRefusal.Licence, MESSAGE.licenceUnread(crate.name, crate.version, licenceUnread));
    await writeChecksums(dir, crate.cksum);
    const digest = (await treeDigest(dir)).sha256;
    return { name: crate.name, version: crate.version, cksum: crate.cksum, ...read, dir, digest, unpacked };
  } catch (error) {
    input.signal?.throwIfAborted();
    return refuse(CrateRefusal.OverlayTampered, MESSAGE.archive(crate.name, crate.version, errorMessage(error)));
  }
}

/** The facts the person is shown about an extracted closure. */
function closureFacts(root: CrateId, crates: readonly VettedCrate[]): ClosureFacts {
  const requested = crates.find((crate) => crateId(crate) === crateId(root));
  return {
    licence: requested?.licence ?? null,
    closureSize: crates.length,
    buildScripts: crates.some((crate) => crate.buildScript),
    procMacros: crates.some((crate) => crate.procMacro),
  };
}

/**
 * The vendor job: each archive extracted into `jobDir/<name>-<version>` with cargo's checksum
 * file, read and digested; then the checker's verdict (its engines write only `jobDir/.check`)
 * and the person's approvals. It opens no socket and writes nothing outside `jobDir`, which it
 * makes fresh; the caller adopts the vetted folders into the overlay (`crate-overlay.ts`) and
 * removes the job folder.
 */
export async function runCrateVendorJob(input: VendorJobInput): Promise<VendorJobResult> {
  await rm(input.jobDir, { recursive: true, force: true });
  await mkdir(input.jobDir, { recursive: true });
  const crates: VettedCrate[] = [];
  let left = input.limits?.closureBytes ?? CLOSURE_UNPACKED_MAX_BYTES;
  for (const crate of input.crates) {
    const vetted = await extractCrate(input, crate, left);
    if ("ok" in vetted)
      return { ...vetted, facts: crates.length ? closureFacts(input.root, crates) : null, check: null };
    const { unpacked, ...read } = vetted;
    left -= unpacked;
    crates.push(read);
  }
  const facts = closureFacts(input.root, crates);
  const verdict = await input.checker.check({ jobDir: input.jobDir, root: input.root, crates, signal: input.signal });
  if (!verdict.ok) {
    const { report, ...refused } = verdict;
    return { ...refused, facts, check: report };
  }
  const refused = approvalRefusal(crates, input.approvals);
  if (refused) return { ...refused, facts, check: verdict.report };
  return { ok: true, crates, facts, check: verdict.report };
}
