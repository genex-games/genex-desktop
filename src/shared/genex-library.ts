/**
 * The Content Library (our Quixel equivalent): a catalog of pre-processed CC0 materials, skies,
 * models and vegetation slots that ships with the Rust stack. The catalog (`src/plugins/library/
 * catalog.json`) names every entry, its upstream source pinned by size and md5, and, once the pack
 * build (`scripts/library/build-library.ts`) has run, every file of the built pack by sha256. The
 * `library` plugin installs an entry's files on demand into its own storage, checks each digest, and
 * delivers them to `assets/library/<folder>/` of a game, where `gfx.assets().library(id)` finds them
 * (`docs/api/library.md`).
 *
 * Pure and browser-safe: the plugin, the build script and the tests share this one reading of the
 * catalog. The delivery folder rule ({@link libraryFolder}) has a Rust twin in
 * `native/genex-rust/crates/genex/src/library.rs`; both tests hold the same vectors.
 */

/** The catalog format this code reads. */
export const LIBRARY_CATALOG_SCHEMA = 1;
/** The entry facts format (`entry.json` in every built entry). */
export const LIBRARY_ENTRY_SCHEMA = 1;
/** The file every built entry carries: what the runtime reads (`LibraryEntryFacts`). */
export const LIBRARY_ENTRY_FILE = "entry.json";
/** The folder of `assets/` that library deliveries land in (the plugin's id). */
export const LIBRARY_ASSET_FOLDER = "library";
/** The most results one search answers. */
export const LIBRARY_SEARCH_LIMIT_MAX = 24;
/** The results a search answers when it names no limit. */
export const LIBRARY_SEARCH_LIMIT_DEFAULT = 8;

/** What an entry is. Wire values in the catalog, `entry.json` and ids: never rename one. */
export const LibraryKind = {
  /** A tiling PBR surface: albedo, normal and ORM maps per tier. */
  Material: "material",
  /** An equirectangular HDRI that lights and backs a scene. */
  Sky: "sky",
  /** A prop, rock or structure: one GLB within its budget, with levels baked in. */
  Model: "model",
  /** A tree or plant: a generator fills the slot (aaa-vegetation), members drawn as one. */
  Vegetation: "vegetation",
} as const;
export type LibraryKind = (typeof LibraryKind)[keyof typeof LibraryKind];

/** A texture or HDRI resolution the pack carries. Wire values: never rename one. */
export const LibraryTier = { OneK: "1k", TwoK: "2k", FourK: "4k" } as const;
export type LibraryTier = (typeof LibraryTier)[keyof typeof LibraryTier];

/** Every tier, smallest first. */
export const LIBRARY_TIERS: readonly LibraryTier[] = [LibraryTier.OneK, LibraryTier.TwoK, LibraryTier.FourK];

/** A material's maps, each a JPEG fallback plus a Basis KTX2 twin. Wire values: never rename one. */
export const LibraryMap = { Albedo: "albedo", Normal: "normal", Orm: "orm" } as const;
export type LibraryMap = (typeof LibraryMap)[keyof typeof LibraryMap];

/** Where an entry came from. Wire values: never rename one. */
export const LibrarySite = {
  PolyHaven: "polyhaven",
  AmbientCg: "ambientcg",
  /** Made by a Genex generator (a vegetation slot's tree). */
  Generated: "generated",
} as const;
export type LibrarySite = (typeof LibrarySite)[keyof typeof LibrarySite];

/** The licences the library carries: CC0 only. */
export const LIBRARY_LICENCE = "CC0-1.0";

/**
 * A model's triangle budget class: its LOD0 may not exceed {@link LIBRARY_BUDGET_TRIANGLES}, and
 * the big classes draw an impostor past their last level. Wire values: never rename one.
 */
export const LibraryBudget = {
  SmallProp: "small-prop",
  Prop: "prop",
  LargeProp: "large-prop",
  Rock: "rock",
  Structure: "structure",
  Vehicle: "vehicle",
  Tree: "tree",
} as const;
export type LibraryBudget = (typeof LibraryBudget)[keyof typeof LibraryBudget];

/** Each budget's LOD0 triangle cap (desktop-high tier; the runtime's levels take it down from there). */
export const LIBRARY_BUDGET_TRIANGLES = {
  [LibraryBudget.SmallProp]: 5_000,
  [LibraryBudget.Prop]: 20_000,
  [LibraryBudget.LargeProp]: 50_000,
  [LibraryBudget.Rock]: 24_000,
  [LibraryBudget.Structure]: 80_000,
  [LibraryBudget.Vehicle]: 80_000,
  [LibraryBudget.Tree]: 60_000,
} as const satisfies Record<LibraryBudget, number>;

/** The budgets whose models draw an impostor past their last mesh level. */
export const LIBRARY_IMPOSTOR_BUDGETS: ReadonlySet<LibraryBudget> = new Set([
  LibraryBudget.Rock,
  LibraryBudget.Structure,
  LibraryBudget.Vehicle,
  LibraryBudget.Tree,
]);

/** A sky's time of day. Wire values: never rename one. */
export const LibrarySkyTime = {
  Dawn: "dawn",
  Morning: "morning",
  Noon: "noon",
  Afternoon: "afternoon",
  Sunset: "sunset",
  Night: "night",
  Interior: "interior",
} as const;
export type LibrarySkyTime = (typeof LibrarySkyTime)[keyof typeof LibrarySkyTime];

/** A sky's weather. Wire values: never rename one. */
export const LibrarySkyWeather = {
  Clear: "clear",
  PartlyCloudy: "partly-cloudy",
  Overcast: "overcast",
  Snow: "snow",
  Studio: "studio",
} as const;
export type LibrarySkyWeather = (typeof LibrarySkyWeather)[keyof typeof LibrarySkyWeather];

/** Why a library call was refused. Wire values the agent reads: never rename one. */
export const LibraryRefusal = {
  CatalogInvalid: "catalog-invalid",
  UnknownEntry: "unknown-entry",
  SlotOpen: "slot-open",
  NotBuilt: "not-built",
  TierUnavailable: "tier-unavailable",
  Unpublished: "unpublished",
  DigestMismatch: "digest-mismatch",
  SizeMismatch: "size-mismatch",
  DownloadFailed: "download-failed",
  NoGame: "no-game",
  BadRequest: "bad-request",
} as const;
export type LibraryRefusal = (typeof LibraryRefusal)[keyof typeof LibraryRefusal];

/** A refused library call: the typed code first, the detail for a log line. */
export class LibraryError extends Error {
  readonly code: LibraryRefusal;
  constructor(code: LibraryRefusal, detail: string) {
    super(detail);
    this.code = code;
    this.name = "LibraryError";
  }
}

/** One upstream file the build reads, pinned by size and md5 (what the source's API publishes). */
export interface LibraryUpstreamFile {
  /** What the build uses it as: a map name, `hdri`, `tonemapped`, `gltf` or a glTF resource path. */
  role: string;
  /** The tier it is the source of, when it is tiered. */
  tier?: LibraryTier;
  url: string;
  bytes: number;
  md5: string;
}

/** One file of the built pack. */
export interface LibraryPackFile {
  /** Its name inside the entry folder (`albedo.2k.jpg`, `entry.json`). */
  name: string;
  /** The tier it belongs to; absent for files every delivery carries. */
  tier?: LibraryTier;
  sha256: string;
  bytes: number;
}

/** What the pack build recorded for an entry. */
export interface LibraryBuild {
  /** The pack version that built it. */
  pack: string;
  files: LibraryPackFile[];
  /** A model's or vegetation's LOD0 triangles. */
  triangles?: number;
}

/** Where an entry came from. */
export interface LibrarySource {
  site: LibrarySite;
  /** The source's own id (`asphalt_02`), or the generator's preset. */
  id: string;
  /** Its page, https. */
  page: string;
  authors: string[];
}

/** A material's catalog facts. */
export interface LibraryMaterialSpec {
  /** How many metres one repeat of the texture covers (the scan's real size). */
  tileMetres: number;
  tiers: LibraryTier[];
}

/** A sky's catalog facts. */
export interface LibrarySkySpec {
  time: LibrarySkyTime;
  weather: LibrarySkyWeather;
  tiers: LibraryTier[];
}

/** A model's catalog facts. */
export interface LibraryModelSpec {
  budget: LibraryBudget;
  /** Its bounding box in metres, x (width), y (height), z (depth). */
  sizeMetres: [number, number, number];
  /** The texture resolution its GLB embeds. */
  tier: LibraryTier;
  /** The source's triangles before decimation. */
  sourceTriangles: number;
}

/** An entry a generator fills (a vegetation species): open until its build is recorded. */
export interface LibrarySlot {
  /** The lane or tool that fills it (`aaa-vegetation`). */
  generator: string;
  /** What to make: species, season, height. */
  brief: string;
  budget: LibraryBudget;
  sizeMetres: [number, number, number];
}

/** One catalog entry. Exactly one of `material`, `sky`, `model` or `slot` is present, as its kind says. */
export interface LibraryEntry {
  /** `<kind>/<slug>`, what `gfx.assets().library(..)` takes. */
  id: string;
  kind: LibraryKind;
  name: string;
  /** One word that groups it (`asphalt`, `brick`, `bench`). */
  category: string;
  tags: string[];
  licence: typeof LIBRARY_LICENCE;
  source: LibrarySource;
  material?: LibraryMaterialSpec;
  sky?: LibrarySkySpec;
  model?: LibraryModelSpec;
  slot?: LibrarySlot;
  upstream?: LibraryUpstreamFile[];
  build?: LibraryBuild;
}

/** Where the built pack is published. */
export interface LibraryPack {
  /** The pack version the built files carry (`2026.10.29`). */
  version: string;
  /** The https folder the pack's files are under (`<base>/<version>/<pack name>`), null until published. */
  baseUrl: string | null;
}

/** The whole catalog. */
export interface LibraryCatalog {
  schema: typeof LIBRARY_CATALOG_SCHEMA;
  pack: LibraryPack;
  entries: LibraryEntry[];
}

/** What `entry.json` holds: the facts the runtime and the search read from a built entry. */
export interface LibraryEntryFacts {
  schema: typeof LIBRARY_ENTRY_SCHEMA;
  id: string;
  kind: LibraryKind;
  name: string;
  tags: string[];
  licence: typeof LIBRARY_LICENCE;
  source: LibrarySource;
  /** Metres: a material's tile (x, y, 0), a model's bounding box; zeros for a sky. */
  size: [number, number, number];
  /** A material's maps per tier, by map name. */
  maps?: Partial<Record<LibraryTier, Record<LibraryMap, string>>>;
  /** A material's mean albedo, sRGB 0..255: its stand-in where no texture loads. */
  baseColor?: [number, number, number];
  /** Texels per metre per tier (a material's maps, a model's embedded textures). */
  texelsPerMetre?: Partial<Record<LibraryTier, number>>;
  /** A sky's HDRI per tier. */
  hdri?: Partial<Record<LibraryTier, string>>;
  time?: LibrarySkyTime;
  weather?: LibrarySkyWeather;
  /** A model's or vegetation's GLBs, drawn as one (a compound when more than one). */
  members?: string[];
  triangles?: number;
  impostor?: boolean;
}

const MESSAGE = {
  NotObject: (at: string) => `${at} is not an object`,
  Field: (at: string, field: string, want: string) => `${at}.${field} must be ${want}`,
  Duplicate: (id: string) => `entry ${id} appears twice`,
  IdShape: (id: string) => `id ${id} must be <kind>/<slug> with a slug of a-z, 0-9 and _ (at most 48)`,
  KindBlock: (id: string, kind: string) => `entry ${id} needs exactly its ${kind} block`,
  OverBudget: (id: string, triangles: number, cap: number) =>
    `entry ${id} has ${triangles} LOD0 triangles, over its budget of ${cap}`,
  SlotBuilt: (id: string) => `entry ${id} is a slot: only a vegetation entry may be one`,
  Schema: (schema: unknown) => `catalog schema ${String(schema)}, this code reads ${LIBRARY_CATALOG_SCHEMA}`,
  UnknownEntry: (id: string) => `no library entry ${id}: search with library__search`,
  SlotOpen: (id: string, generator: string) =>
    `${id} is a slot ${generator} has not filled yet: use another entry or the generator`,
  NotBuilt: (id: string) => `${id} is in the catalog but not in the built pack yet`,
  TierUnavailable: (id: string, tier: string, tiers: readonly string[]) =>
    `${id} has no ${tier} tier; it has ${tiers.join(", ") || "none"}`,
} as const;

const SLUG = /^[a-z0-9_]{1,48}$/;
const FILE_NAME = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MD5 = /^[a-f0-9]{32}$/;
const TAG = /^[a-z0-9][a-z0-9 -]{0,31}$/;
const VERSION = /^\d{4}\.\d{1,2}\.\d{1,2}$/;
const KINDS: ReadonlySet<string> = new Set(Object.values(LibraryKind));
const SITES: ReadonlySet<string> = new Set(Object.values(LibrarySite));
const TIERS: ReadonlySet<string> = new Set(LIBRARY_TIERS);
const BUDGETS: ReadonlySet<string> = new Set(Object.values(LibraryBudget));
const SKY_TIMES: ReadonlySet<string> = new Set(Object.values(LibrarySkyTime));
const SKY_WEATHERS: ReadonlySet<string> = new Set(Object.values(LibrarySkyWeather));
/** The kind each spec block belongs to. */
const KIND_BLOCKS = {
  material: LibraryKind.Material,
  sky: LibraryKind.Sky,
  model: LibraryKind.Model,
  slot: LibraryKind.Vegetation,
} as const;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function invalid(detail: string): LibraryError {
  return new LibraryError(LibraryRefusal.CatalogInvalid, detail);
}

function object(value: unknown, at: string): Json {
  if (!isObject(value)) throw invalid(MESSAGE.NotObject(at));
  return value;
}

function text(json: Json, at: string, field: string, pattern?: RegExp): string {
  const value = json[field];
  const fits = typeof value === "string" && value.length > 0 && value.length <= 512;
  if (!fits || (pattern && !pattern.test(value))) throw invalid(MESSAGE.Field(at, field, "a valid string"));
  return value;
}

function oneOf<T extends string>(json: Json, at: string, field: string, allowed: ReadonlySet<string>): T {
  const value = json[field];
  if (typeof value !== "string" || !allowed.has(value)) {
    throw invalid(MESSAGE.Field(at, field, `one of ${[...allowed].join(", ")}`));
  }
  return value as T;
}

function positive(json: Json, at: string, field: string, integer = false): number {
  const value = json[field];
  const fits = typeof value === "number" && Number.isFinite(value) && value > 0;
  if (!fits || (integer && !Number.isInteger(value))) throw invalid(MESSAGE.Field(at, field, "a positive number"));
  return value;
}

function https(json: Json, at: string, field: string): string {
  const value = text(json, at, field);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid(MESSAGE.Field(at, field, "an https URL"));
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw invalid(MESSAGE.Field(at, field, "an https URL"));
  return value;
}

function strings(json: Json, at: string, field: string, pattern: RegExp, min = 0): string[] {
  const value = json[field];
  const fits = Array.isArray(value) && value.length >= min && value.length <= 64;
  if (!fits || !value.every((item) => typeof item === "string" && pattern.test(item))) {
    throw invalid(MESSAGE.Field(at, field, `a list of strings matching ${pattern}`));
  }
  return [...(value as string[])];
}

function tiers(json: Json, at: string): LibraryTier[] {
  const value = json.tiers;
  const known = Array.isArray(value) && value.length > 0 && value.every((tier) => TIERS.has(String(tier)));
  const sorted =
    known && value.every((tier, i) => i === 0 || LIBRARY_TIERS.indexOf(value[i - 1]) < LIBRARY_TIERS.indexOf(tier));
  if (!sorted) throw invalid(MESSAGE.Field(at, "tiers", "known tiers, smallest first, each once"));
  return value as LibraryTier[];
}

function size3(json: Json, at: string, field: string): [number, number, number] {
  const value = json[field];
  const fits =
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0);
  if (!fits || !value.some((n) => n > 0)) throw invalid(MESSAGE.Field(at, field, "three metres, not all zero"));
  return [value[0], value[1], value[2]];
}

function sourceOf(value: unknown, at: string): LibrarySource {
  const json = object(value, `${at}.source`);
  return {
    site: oneOf<LibrarySite>(json, `${at}.source`, "site", SITES),
    id: text(json, `${at}.source`, "id"),
    page: https(json, `${at}.source`, "page"),
    authors: strings(json, `${at}.source`, "authors", /^.{1,80}$/),
  };
}

function materialOf(value: unknown, at: string): LibraryMaterialSpec {
  const json = object(value, at);
  return { tileMetres: positive(json, at, "tileMetres"), tiers: tiers(json, at) };
}

function skyOf(value: unknown, at: string): LibrarySkySpec {
  const json = object(value, at);
  return {
    time: oneOf<LibrarySkyTime>(json, at, "time", SKY_TIMES),
    weather: oneOf<LibrarySkyWeather>(json, at, "weather", SKY_WEATHERS),
    tiers: tiers(json, at),
  };
}

function modelOf(value: unknown, at: string): LibraryModelSpec {
  const json = object(value, at);
  return {
    budget: oneOf<LibraryBudget>(json, at, "budget", BUDGETS),
    sizeMetres: size3(json, at, "sizeMetres"),
    tier: oneOf<LibraryTier>(json, at, "tier", TIERS),
    sourceTriangles: positive(json, at, "sourceTriangles", true),
  };
}

function slotOf(value: unknown, at: string): LibrarySlot {
  const json = object(value, at);
  return {
    generator: text(json, at, "generator"),
    brief: text(json, at, "brief"),
    budget: oneOf<LibraryBudget>(json, at, "budget", BUDGETS),
    sizeMetres: size3(json, at, "sizeMetres"),
  };
}

function upstreamOf(value: unknown, at: string): LibraryUpstreamFile[] {
  if (!Array.isArray(value)) throw invalid(MESSAGE.Field(at, "upstream", "a list"));
  return value.map((item, i) => {
    const json = object(item, `${at}.upstream[${i}]`);
    const file: LibraryUpstreamFile = {
      role: text(json, `${at}.upstream[${i}]`, "role"),
      url: https(json, `${at}.upstream[${i}]`, "url"),
      bytes: positive(json, `${at}.upstream[${i}]`, "bytes", true),
      md5: text(json, `${at}.upstream[${i}]`, "md5", MD5),
    };
    if (json.tier !== undefined) file.tier = oneOf<LibraryTier>(json, `${at}.upstream[${i}]`, "tier", TIERS);
    return file;
  });
}

function buildOf(value: unknown, at: string): LibraryBuild {
  const json = object(value, at);
  if (!Array.isArray(json.files) || json.files.length === 0)
    throw invalid(MESSAGE.Field(at, "files", "a non-empty list"));
  const names = new Set<string>();
  const files = json.files.map((item, i) => {
    const file = object(item, `${at}.files[${i}]`);
    const name = text(file, `${at}.files[${i}]`, "name", FILE_NAME);
    if (names.has(name)) throw invalid(MESSAGE.Duplicate(name));
    names.add(name);
    const packed: LibraryPackFile = {
      name,
      sha256: text(file, `${at}.files[${i}]`, "sha256", SHA256),
      bytes: positive(file, `${at}.files[${i}]`, "bytes", true),
    };
    if (file.tier !== undefined) packed.tier = oneOf<LibraryTier>(file, `${at}.files[${i}]`, "tier", TIERS);
    return packed;
  });
  if (!names.has(LIBRARY_ENTRY_FILE)) throw invalid(MESSAGE.Field(at, "files", `a list with ${LIBRARY_ENTRY_FILE}`));
  const build: LibraryBuild = { pack: text(json, at, "pack", VERSION), files };
  if (json.triangles !== undefined) build.triangles = positive(json, at, "triangles", true);
  return build;
}

/** The kind's spec block, checked: exactly the one block the kind has. */
function specOf(json: Json, id: string, kind: LibraryKind): Partial<LibraryEntry> {
  const present = Object.entries(KIND_BLOCKS).filter(([block]) => json[block] !== undefined);
  const only = present.length === 1 && present[0]?.[1] === kind;
  if (!only) throw invalid(MESSAGE.KindBlock(id, kind));
  if (kind === LibraryKind.Material) return { material: materialOf(json.material, `${id}.material`) };
  if (kind === LibraryKind.Sky) return { sky: skyOf(json.sky, `${id}.sky`) };
  if (kind === LibraryKind.Model) return { model: modelOf(json.model, `${id}.model`) };
  return { slot: slotOf(json.slot, `${id}.slot`) };
}

/** The LOD0 triangle cap of an entry with a budget, or null. */
export function budgetOf(entry: Pick<LibraryEntry, "model" | "slot">): number | null {
  const budget = entry.model?.budget ?? entry.slot?.budget;
  return budget ? LIBRARY_BUDGET_TRIANGLES[budget] : null;
}

function entryOf(value: unknown, i: number): LibraryEntry {
  const json = object(value, `entries[${i}]`);
  const id = text(json, `entries[${i}]`, "id");
  const kind = oneOf<LibraryKind>(json, id, "kind", KINDS);
  const [prefix, slug, ...rest] = id.split("/");
  if (prefix !== kind || !slug || !SLUG.test(slug) || rest.length > 0) throw invalid(MESSAGE.IdShape(id));
  if (json.licence !== LIBRARY_LICENCE) throw invalid(MESSAGE.Field(id, "licence", LIBRARY_LICENCE));
  const entry: LibraryEntry = {
    id,
    kind,
    name: text(json, id, "name"),
    category: text(json, id, "category", SLUG),
    tags: strings(json, id, "tags", TAG, 1),
    licence: LIBRARY_LICENCE,
    source: sourceOf(json.source, id),
    ...specOf(json, id, kind),
  };
  if (json.upstream !== undefined) entry.upstream = upstreamOf(json.upstream, id);
  if (json.build !== undefined) entry.build = buildOf(json.build, `${id}.build`);
  const cap = budgetOf(entry);
  const triangles = entry.build?.triangles;
  if (cap !== null && triangles !== undefined && triangles > cap) throw invalid(MESSAGE.OverBudget(id, triangles, cap));
  return entry;
}

/** `value` checked as a catalog; throws a `catalog-invalid` {@link LibraryError} naming the first fault. */
export function parseLibraryCatalog(value: unknown): LibraryCatalog {
  const json = object(value, "catalog");
  if (json.schema !== LIBRARY_CATALOG_SCHEMA) throw invalid(MESSAGE.Schema(json.schema));
  const pack = object(json.pack, "pack");
  const baseUrl = pack.baseUrl === null ? null : https(pack, "pack", "baseUrl");
  if (!Array.isArray(json.entries)) throw invalid(MESSAGE.Field("catalog", "entries", "a list"));
  const entries = json.entries.map(entryOf);
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) throw invalid(MESSAGE.Duplicate(entry.id));
    seen.add(entry.id);
  }
  return {
    schema: LIBRARY_CATALOG_SCHEMA,
    pack: { version: text(pack, "pack", "version", VERSION), baseUrl },
    entries,
  };
}

/** The tiers an entry's build carries, smallest first (a model's single tier, none for a sky not built). */
export function builtTiers(entry: LibraryEntry): LibraryTier[] {
  const tiers = new Set(entry.build?.files.flatMap((file) => (file.tier ? [file.tier] : [])) ?? []);
  return LIBRARY_TIERS.filter((tier) => tiers.has(tier));
}

/**
 * The files one delivery of `id` at `tier` carries (every untiered file plus that tier's), or a
 * refusal: an unknown id, a slot nobody filled, an entry not built yet, or a tier it lacks. A
 * `tier` left out takes the entry's 2k tier when it has one, else its largest.
 */
export function deliveryFiles(
  catalog: LibraryCatalog,
  id: string,
  tier?: LibraryTier,
): { entry: LibraryEntry; tier: LibraryTier | null; files: LibraryPackFile[] } {
  const entry = catalog.entries.find((known) => known.id === id);
  if (!entry) throw new LibraryError(LibraryRefusal.UnknownEntry, MESSAGE.UnknownEntry(id));
  if (entry.slot && !entry.build)
    throw new LibraryError(LibraryRefusal.SlotOpen, MESSAGE.SlotOpen(id, entry.slot.generator));
  if (!entry.build) throw new LibraryError(LibraryRefusal.NotBuilt, MESSAGE.NotBuilt(id));
  const available = builtTiers(entry);
  const chosen = tier ?? defaultTier(available);
  if (chosen !== null && !available.includes(chosen)) {
    throw new LibraryError(LibraryRefusal.TierUnavailable, MESSAGE.TierUnavailable(id, chosen, available));
  }
  const files = entry.build.files.filter((file) => file.tier === undefined || file.tier === chosen);
  return { entry, tier: chosen, files };
}

/** 2k when the entry has it, else its largest tier, else none (an untiered entry). */
function defaultTier(available: readonly LibraryTier[]): LibraryTier | null {
  if (available.includes(LibraryTier.TwoK)) return LibraryTier.TwoK;
  return available.at(-1) ?? null;
}

/** A search request. */
export interface LibraryQuery {
  query: string;
  kind?: LibraryKind;
  limit?: number;
}

/** One search result. */
export interface LibraryHit {
  id: string;
  kind: LibraryKind;
  name: string;
  category: string;
  tags: string[];
  /** Whether `library__add` can deliver it now (built), or it is an open slot. */
  status: "ready" | "slot-open" | "not-built";
  tiers: LibraryTier[];
  sizeMetres?: [number, number, number];
  tileMetres?: number;
  triangles?: number;
  time?: LibrarySkyTime;
  weather?: LibrarySkyWeather;
  score: number;
}

/** Lowercase words of two or more letters or digits. */
function words(textValue: string): string[] {
  return textValue
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 2);
}

/** Weights of where a query word matched: the id and name first, then the category, then the tags. */
const SEARCH_WEIGHT = { Name: 3, Category: 2, Tag: 2, Kind: 1, Prefix: 1 } as const;

/** How well one query word matches `entry`: the best of its places, 0 for none. */
function wordScore(word: string, entry: LibraryEntry): number {
  const nameWords = new Set([...words(entry.name), ...words(entry.id)]);
  const tagWords = new Set(entry.tags.flatMap(words));
  if (nameWords.has(word)) return SEARCH_WEIGHT.Name;
  if (entry.category === word) return SEARCH_WEIGHT.Category;
  if (tagWords.has(word)) return SEARCH_WEIGHT.Tag;
  if (entry.kind === word) return SEARCH_WEIGHT.Kind;
  const prefix =
    word.length >= 3 && [...nameWords, ...tagWords, entry.category].some((known) => known.startsWith(word));
  return prefix ? SEARCH_WEIGHT.Prefix : 0;
}

function hitOf(entry: LibraryEntry, score: number): LibraryHit {
  let status: LibraryHit["status"] = "ready";
  if (!entry.build) status = entry.slot ? "slot-open" : "not-built";
  const hit: LibraryHit = {
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    category: entry.category,
    tags: entry.tags,
    status,
    tiers: builtTiers(entry),
    score,
  };
  const size = entry.model?.sizeMetres ?? entry.slot?.sizeMetres;
  if (size) hit.sizeMetres = size;
  if (entry.material) hit.tileMetres = entry.material.tileMetres;
  if (entry.build?.triangles !== undefined) hit.triangles = entry.build.triangles;
  if (entry.sky) {
    hit.time = entry.sky.time;
    hit.weather = entry.sky.weather;
  }
  return hit;
}

/**
 * The entries matching any word of `query.query` (not every word: "snow ground" finds snow and
 * ground surfaces), best first: each word scores where it matched (name, category, tag, kind, a
 * prefix), built entries rank before open slots, ties by id. `kind` narrows; `limit` is 1..24.
 */
export function searchLibrary(catalog: LibraryCatalog, query: LibraryQuery): LibraryHit[] {
  const asked = [...new Set(words(query.query))];
  const limit = Math.min(
    Math.max(Math.trunc(query.limit ?? LIBRARY_SEARCH_LIMIT_DEFAULT), 1),
    LIBRARY_SEARCH_LIMIT_MAX,
  );
  const scored = catalog.entries
    .filter((entry) => !query.kind || entry.kind === query.kind)
    .map((entry) => ({ entry, score: asked.reduce((sum, word) => sum + wordScore(word, entry), 0) }))
    .filter(({ score }) => score > 0);
  scored.sort(
    (a, b) =>
      b.score - a.score || Number(!!b.entry.build) - Number(!!a.entry.build) || (a.entry.id < b.entry.id ? -1 : 1),
  );
  return scored.slice(0, limit).map(({ entry, score }) => hitOf(entry, score));
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const U64 = (1n << 64n) - 1n;

/** FNV-1a 64 of `value`'s UTF-8 bytes, 16 lowercase hex. */
function fnv1a64Hex(value: string): string {
  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(value)) hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & U64;
  return hash.toString(16).padStart(16, "0");
}

/**
 * The delivery folder of entry `id` under `assets/library/`: a UUID-shaped name (what a plugin
 * delivery's job id must be) made from two FNV-1a 64 digests of the id, so the plugin and
 * `gfx.assets().library(id)` reach the same folder without a shared index.
 */
export function libraryFolder(id: string): string {
  const hex = fnv1a64Hex(`genex-library\n${id}`) + fnv1a64Hex(`folder\n${id}`);
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
}

/** The flat name of an entry's file in the published pack (`material.asphalt_02.albedo.2k.jpg`). */
export function packFileName(id: string, name: string): string {
  return `${id.replace("/", ".")}.${name}`;
}
