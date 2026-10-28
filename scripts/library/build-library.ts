/**
 * The Genex Library's reproducible pack build (`docs/api/library.md#building-the-pack`).
 *
 *   node scripts/library/build-library.ts pin [--only <id,...>]
 *     Expand `picks.ts` from Poly Haven's API into `src/plugins/library/catalog.json`: name, tags,
 *     authors, real size, and every upstream file pinned by size and md5. A built entry whose
 *     upstream is unchanged keeps its build record.
 *   node scripts/library/build-library.ts build [--only <id,...>|starter] [--tiers 2k,4k] [--out <dir>]
 *     Download each entry's pinned sources (md5 and size checked, cached in .studio-dev/), process
 *     them (a material's maps kept as JPEG with a Basis UASTC KTX2 twin each; a sky's HDRIs; a model
 *     packed into one GLB, decimated to its budget, levels baked in) and write the pack's flat files
 *     under `<out>/<pack version>/`, recording each file's sha256 in the catalog.
 *   node scripts/library/build-library.ts fill vegetation/<slug>=<dir> [--out <dir>]
 *     Fill a vegetation slot from a generator's output folder (`trunk.glb`, optional `foliage.glb`).
 *   node scripts/library/build-library.ts previews <renders dir> [--out <dir>]
 *     Take `<kind>.<slug>.png` renders (the library contact-sheet row) as the entries' previews.
 *   node scripts/library/build-library.ts stage <assets dir> [--only <id,...>] [--tier 2k] [--out <dir>]
 *     Install entries from the local pack into a folder laid out as a game's `assets/`, exactly as
 *     `library__add` delivers them (for the examples' rows).
 *
 * Network: Poly Haven's API and download hosts only. Run it under the heavy-job lock: encoding 4k
 * textures takes minutes per material.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { packGlb } from "../../src/plugins/cc0/glb.ts";
import { stageDelivery } from "../../src/plugins/library/install.ts";
import {
  budgetOf,
  LIBRARY_ENTRY_FILE,
  LIBRARY_LICENCE,
  LibraryKind,
  type LibraryBuild,
  type LibraryCatalog,
  type LibraryEntry,
  type LibraryEntryFacts,
  LibraryMap,
  type LibraryPackFile,
  LibrarySite,
  LibraryTier,
  type LibraryUpstreamFile,
  libraryFolder,
  packFileName,
  parseLibraryCatalog,
} from "../../src/shared/genex-library.ts";
import { encodeKtx2, TextureUsage } from "../../src/substrate/asset-import/basis-encoder.ts";
import { decodeImage, textureEncoder } from "../../src/substrate/asset-import/texture-encode.ts";
import { checkRadiance } from "../../src/substrate/asset-import/hdr.ts";
import { fetchBasis } from "../toolchains/importer-tools.ts";
import {
  decimateGlb,
  glbTriangles,
  type MaterialTier,
  materialFacts,
  meanColor,
  modelFacts,
  previewJpeg,
  skyFacts,
  withLevels,
} from "./pack.ts";
import { LIBRARY_PICKS, type LibraryPick, MODEL_TIER, PICK_TIERS, STARTER_IDS } from "./picks.ts";

const REPO = path.resolve(import.meta.dirname, "../..");
const CATALOG_FILE = path.join(REPO, "src/plugins/library/catalog.json");
const CACHE_DIR = path.join(REPO, ".studio-dev/library-cache");
const PACK_DIR = path.join(REPO, ".studio-dev/library-pack");
const POLYHAVEN_API = "https://api.polyhaven.com";
const POLYHAVEN_PAGE = "https://polyhaven.com/a/";
const SOURCE_HOSTS: ReadonlySet<string> = new Set(["api.polyhaven.com", "dl.polyhaven.org"]);
const USER_AGENT = "Genex-Library-Build/1.0 (+https://github.com/genex-games/genex-desktop)";
/** The most tags an entry keeps (the pick's first, then the source's). */
const TAGS_MAX = 12;
const TAG = /^[a-z0-9][a-z0-9 -]{0,31}$/;
const MM_PER_METRE = 1000;
/** Poly Haven's names for a material's maps, by ours, and how each is encoded. */
const POLYHAVEN_MAPS = [
  { map: LibraryMap.Albedo, key: "Diffuse", usage: TextureUsage.Color },
  { map: LibraryMap.Normal, key: "nor_gl", usage: TextureUsage.Normal },
  { map: LibraryMap.Orm, key: "arm", usage: TextureUsage.Data },
] as const;
/** The generator's members a vegetation slot takes, in drawing order. */
const VEGETATION_MEMBERS = ["trunk.glb", "foliage.glb"] as const;
/** A sky preview's size (equirectangular, 2:1). */
const SKY_PREVIEW = { width: 512, height: 256 } as const;

const MESSAGE = {
  Host: (url: string) => `${url}: not a Poly Haven host`,
  Http: (url: string, status: number) => `${url}: HTTP ${status}`,
  Pin: (url: string) => `${url}: size or md5 is not the catalog's pin (upstream changed: run pin again)`,
  NoMap: (source: string, key: string, tier: string) => `${source} has no ${key} JPEG at ${tier}: pick another texture`,
  NoHdri: (source: string, tier: string) => `${source} has no ${tier} HDRI`,
  NoGltf: (source: string, tier: string) => `${source} has no ${tier} glTF`,
  Unbuildable: (id: string) => `${id}: a slot is filled with fill, not built`,
  Built: (id: string, files: number, bytes: number) => `built ${id}: ${files} files, ${(bytes / 1e6).toFixed(1)} MB`,
  Staged: (id: string, folder: string) => `staged ${id} in ${folder}`,
  FillUsage: "fill takes vegetation/<slug>=<folder with trunk.glb and optional foliage.glb>",
  NoTrunk: (dir: string) => `${dir} has no trunk.glb`,
} as const;

type Json = Record<string, unknown>;
const md5 = (bytes: Uint8Array) => createHash("md5").update(bytes).digest("hex");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** `url` checked to be https on a Poly Haven host. */
function sourceUrl(url: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !SOURCE_HOSTS.has(parsed.hostname)) throw new Error(MESSAGE.Host(url));
  return parsed;
}

async function getJson(url: string): Promise<Json> {
  const response = await fetch(sourceUrl(url), { headers: { "user-agent": USER_AGENT } });
  if (!response.ok) throw new Error(MESSAGE.Http(url, response.status));
  return (await response.json()) as Json;
}

/** An upstream file's bytes, from the cache or downloaded, held to its size and md5 pin. */
async function upstream(file: LibraryUpstreamFile): Promise<Uint8Array> {
  const cached = path.join(CACHE_DIR, file.md5);
  if (existsSync(cached)) {
    const bytes = new Uint8Array(await readFile(cached));
    if (bytes.byteLength === file.bytes && md5(bytes) === file.md5) return bytes;
  }
  const response = await fetch(sourceUrl(file.url), { headers: { "user-agent": USER_AGENT } });
  if (!response.ok) throw new Error(MESSAGE.Http(file.url, response.status));
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== file.bytes || md5(bytes) !== file.md5) throw new Error(MESSAGE.Pin(file.url));
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cached, bytes);
  return bytes;
}

/** A Poly Haven file row as an upstream pin. */
function pinOf(row: unknown, role: string, tier?: LibraryTier): LibraryUpstreamFile | null {
  if (!row || typeof row !== "object") return null;
  const { url, size, md5: digest } = row as Json;
  if (typeof url !== "string" || typeof size !== "number" || typeof digest !== "string") return null;
  return { role, ...(tier ? { tier } : {}), url, bytes: size, md5: digest };
}

const at = (json: unknown, ...keys: string[]): unknown =>
  keys.reduce<unknown>((value, key) => (value && typeof value === "object" ? (value as Json)[key] : undefined), json);

function materialUpstream(source: string, files: Json): LibraryUpstreamFile[] {
  return PICK_TIERS.flatMap((tier) =>
    POLYHAVEN_MAPS.map(({ map, key }) => {
      const pin = pinOf(at(files, key, tier, "jpg"), map, tier);
      if (!pin) throw new Error(MESSAGE.NoMap(source, key, tier));
      return pin;
    }),
  );
}

function skyUpstream(source: string, files: Json): LibraryUpstreamFile[] {
  const hdris = PICK_TIERS.map((tier) => {
    const pin = pinOf(at(files, "hdri", tier, "hdr"), "hdri", tier);
    if (!pin) throw new Error(MESSAGE.NoHdri(source, tier));
    return pin;
  });
  const tonemapped = pinOf(at(files, "tonemapped"), "tonemapped");
  return tonemapped ? [...hdris, tonemapped] : hdris;
}

function modelUpstream(source: string, files: Json): LibraryUpstreamFile[] {
  const gltf = at(files, "gltf", MODEL_TIER, "gltf");
  const main = pinOf(gltf, "gltf");
  if (!main) throw new Error(MESSAGE.NoGltf(source, MODEL_TIER));
  const include = (at(gltf, "include") ?? {}) as Json;
  const resources = Object.entries(include).map(([role, row]) => pinOf(row, role));
  return [main, ...resources.filter((pin): pin is LibraryUpstreamFile => pin !== null)];
}

/** The pick's tags first, then the source's, lowercase and unique, at most {@link TAGS_MAX}. */
function tagsOf(pick: LibraryPick, info: Json): string[] {
  const source = Array.isArray(info.tags) ? info.tags.map((tag) => String(tag).toLowerCase()) : [];
  return [...new Set([...pick.tags, ...source])].filter((tag) => TAG.test(tag)).slice(0, TAGS_MAX);
}

/** A model's real size in metres, x, y (height), z, from Poly Haven's Blender-axis millimetres. */
function sizeOf(info: Json): [number, number, number] {
  const [x = 0, y = 0, z = 0] = Array.isArray(info.dimensions) ? (info.dimensions as number[]) : [];
  const metres = (mm: number) => Math.round((mm / MM_PER_METRE) * 1000) / 1000;
  return [metres(x), metres(z), metres(y)];
}

function slotEntry(pick: Extract<LibraryPick, { kind: "vegetation" }>): LibraryEntry {
  return {
    id: `${LibraryKind.Vegetation}/${pick.slug}`,
    kind: LibraryKind.Vegetation,
    name: pick.name,
    category: pick.category,
    tags: pick.tags,
    licence: LIBRARY_LICENCE,
    source: {
      site: LibrarySite.Generated,
      id: pick.slug,
      page: "https://github.com/genex-games/genex-desktop",
      authors: ["Genex"],
    },
    slot: { generator: "aaa-vegetation", brief: pick.brief, budget: pick.budget, sizeMetres: pick.sizeMetres },
  };
}

/** One pick expanded from the source's API into a catalog entry (its build record not yet merged). */
async function pinPick(pick: LibraryPick): Promise<LibraryEntry> {
  if (pick.kind === LibraryKind.Vegetation) return slotEntry(pick);
  const info = await getJson(`${POLYHAVEN_API}/info/${pick.source}`);
  const files = await getJson(`${POLYHAVEN_API}/files/${pick.source}`);
  const base = {
    id: `${pick.kind}/${pick.source.toLowerCase()}`,
    kind: pick.kind,
    name: String(info.name ?? pick.source),
    tags: tagsOf(pick, info),
    licence: LIBRARY_LICENCE,
    source: {
      site: LibrarySite.PolyHaven,
      id: pick.source,
      page: `${POLYHAVEN_PAGE}${pick.source}`,
      authors: Object.keys((info.authors ?? {}) as Json),
    },
  } as const;
  if (pick.kind === LibraryKind.Material) {
    const [width = MM_PER_METRE] = Array.isArray(info.dimensions) ? (info.dimensions as number[]) : [];
    const tileMetres = Math.round((width / MM_PER_METRE) * 100) / 100;
    return {
      ...base,
      category: pick.category,
      material: { tileMetres, tiers: [...PICK_TIERS] },
      upstream: materialUpstream(pick.source, files),
    };
  }
  if (pick.kind === LibraryKind.Sky) {
    return {
      ...base,
      category: "sky",
      sky: { time: pick.time, weather: pick.weather, tiers: [...PICK_TIERS] },
      upstream: skyUpstream(pick.source, files),
    };
  }
  const sourceTriangles = Math.max(1, Number(info.polycount ?? 1));
  const model = { budget: pick.budget, sizeMetres: sizeOf(info), tier: MODEL_TIER, sourceTriangles };
  return { ...base, category: pick.category, model, upstream: modelUpstream(pick.source, files) };
}

async function readCatalog(): Promise<LibraryCatalog> {
  return parseLibraryCatalog(JSON.parse(await readFile(CATALOG_FILE, "utf8")));
}

async function writeCatalog(catalog: LibraryCatalog): Promise<void> {
  parseLibraryCatalog(JSON.parse(JSON.stringify(catalog)));
  await writeFile(CATALOG_FILE, `${JSON.stringify(catalog, null, 2)}\n`);
}

const idOfPick = (pick: LibraryPick) =>
  pick.kind === LibraryKind.Vegetation ? `${pick.kind}/${pick.slug}` : `${pick.kind}/${pick.source.toLowerCase()}`;

async function pin(only: ReadonlySet<string> | null): Promise<void> {
  const catalog = await readCatalog();
  const known = new Map(catalog.entries.map((entry) => [entry.id, entry]));
  const entries: LibraryEntry[] = [];
  for (const pick of LIBRARY_PICKS) {
    const id = idOfPick(pick);
    const before = known.get(id);
    if (only && !only.has(id) && before) {
      entries.push(before);
      continue;
    }
    const entry = await pinPick(pick);
    const unchanged = before?.build && JSON.stringify(before.upstream) === JSON.stringify(entry.upstream);
    entries.push(unchanged && before.build ? { ...entry, build: before.build } : entry);
    console.log(`pinned ${id}`);
  }
  await writeCatalog({ ...catalog, entries });
}

/** The files one build writes, collected with their pins. */
class PackWriter {
  readonly files: LibraryPackFile[] = [];
  readonly dir: string;
  readonly id: string;
  constructor(out: string, version: string, id: string) {
    this.dir = path.join(out, version);
    this.id = id;
  }
  async add(name: string, bytes: Uint8Array, tier?: LibraryTier): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(path.join(this.dir, packFileName(this.id, name)), bytes);
    this.files.push({ name, ...(tier ? { tier } : {}), sha256: sha256(bytes), bytes: bytes.byteLength });
    return name;
  }
  async facts(facts: LibraryEntryFacts): Promise<void> {
    await this.add(LIBRARY_ENTRY_FILE, new TextEncoder().encode(`${JSON.stringify(facts, null, 2)}\n`));
  }
}

const upstreamOf = (entry: LibraryEntry, role: string, tier?: LibraryTier) =>
  entry.upstream?.find((file) => file.role === role && file.tier === tier);

async function buildMaterial(entry: LibraryEntry, pack: PackWriter, tiers: readonly LibraryTier[]): Promise<void> {
  const built: MaterialTier[] = [];
  let baseColor: [number, number, number] = [128, 128, 128];
  for (const tier of tiers) {
    const maps = {} as Record<LibraryMap, string>;
    let side = 0;
    for (const { map, usage } of POLYHAVEN_MAPS) {
      const source = upstreamOf(entry, map, tier);
      if (!source) continue;
      const bytes = await upstream(source);
      maps[map] = await pack.add(`${map}.${tier}.jpg`, bytes, tier);
      await pack.add(`${map}.${tier}.ktx2`, await basisOf(bytes, usage), tier);
      if (map !== LibraryMap.Albedo) continue;
      const image = await decodeImage(bytes);
      side = image.width;
      if (built.length > 0) continue;
      baseColor = meanColor(image);
      await pack.add("preview.jpg", await previewJpeg(image));
    }
    built.push({ tier, side, maps });
  }
  await pack.facts(materialFacts(entry, built, baseColor));
}

/** `bytes` encoded as the importer's Basis UASTC KTX2 (mipmapped, Zstandard), the file its families are transcoded from. */
async function basisOf(bytes: Uint8Array, usage: TextureUsage): Promise<Uint8Array> {
  const encoded = await encodeKtx2(await textureEncoder(), bytes, usage);
  if (!("bytes" in encoded)) throw new Error(`not encoded: ${encoded.skipped}`);
  return encoded.bytes;
}

/** A box-filtered `width` x `height` JPEG of an equirectangular image. */
async function skyPreview(bytes: Uint8Array): Promise<Uint8Array> {
  const image = await decodeImage(bytes);
  const { width, height } = SKY_PREVIEW;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = (Math.floor((y * image.height) / height) * image.width + Math.floor((x * image.width) / width)) * 4;
      out.set(image.data.subarray(from, from + 4), (y * width + x) * 4);
    }
  }
  const { default: jpeg } = await import("jpeg-js");
  return new Uint8Array(jpeg.encode({ width, height, data: Buffer.from(out) }, 85).data);
}

async function buildSky(entry: LibraryEntry, pack: PackWriter, tiers: readonly LibraryTier[]): Promise<void> {
  const hdri: Partial<Record<LibraryTier, string>> = {};
  for (const tier of tiers) {
    const source = upstreamOf(entry, "hdri", tier);
    if (!source) continue;
    const bytes = await upstream(source);
    checkRadiance(bytes);
    hdri[tier] = await pack.add(`sky.${tier}.hdr`, bytes, tier);
  }
  const tonemapped = upstreamOf(entry, "tonemapped");
  if (tonemapped) await pack.add("preview.jpg", await skyPreview(await upstream(tonemapped)));
  await pack.facts(skyFacts(entry, hdri));
}

async function buildModel(entry: LibraryEntry, pack: PackWriter): Promise<number> {
  const gltf = entry.upstream?.find((file) => file.role === "gltf");
  if (!gltf) throw new Error(MESSAGE.NoGltf(entry.id, MODEL_TIER));
  const resources = new Map<string, Uint8Array>();
  for (const file of entry.upstream ?? []) if (file !== gltf) resources.set(file.role, await upstream(file));
  const packed = packGlb(await upstream(gltf), resources);
  const cap = budgetOf(entry) ?? glbTriangles(packed);
  const { bytes, triangles } = await decimateGlb(packed, cap);
  await pack.add("model.glb", (await withLevels(bytes)).bytes);
  await pack.facts(modelFacts(entry, ["model.glb"], triangles));
  return triangles;
}

async function buildEntry(
  entry: LibraryEntry,
  out: string,
  version: string,
  tiers: readonly LibraryTier[],
): Promise<LibraryBuild> {
  const pack = new PackWriter(out, version, entry.id);
  const build: LibraryBuild = { pack: version, files: pack.files };
  if (entry.kind === LibraryKind.Material) await buildMaterial(entry, pack, tiers);
  else if (entry.kind === LibraryKind.Sky) await buildSky(entry, pack, tiers);
  else if (entry.kind === LibraryKind.Model) build.triangles = await buildModel(entry, pack);
  else throw new Error(MESSAGE.Unbuildable(entry.id));
  console.log(
    MESSAGE.Built(
      entry.id,
      pack.files.length,
      pack.files.reduce((sum, file) => sum + file.bytes, 0),
    ),
  );
  return build;
}

async function build(only: ReadonlySet<string> | null, tiers: readonly LibraryTier[], out: string): Promise<void> {
  await fetchBasis();
  const catalog = await readCatalog();
  for (const entry of catalog.entries) {
    if (entry.slot || (only && !only.has(entry.id))) continue;
    const wanted =
      entry.kind === LibraryKind.Model
        ? []
        : tiers.filter((tier) => entry.material?.tiers.includes(tier) || entry.sky?.tiers.includes(tier));
    entry.build = await buildEntry(entry, out, catalog.pack.version, wanted);
    await writeCatalog(catalog);
  }
}

async function fill(spec: string, out: string): Promise<void> {
  const [id = "", dir = ""] = spec.split("=");
  if (!id.startsWith(`${LibraryKind.Vegetation}/`) || !dir) throw new Error(MESSAGE.FillUsage);
  const catalog = await readCatalog();
  const entry = catalog.entries.find((known) => known.id === id);
  if (!entry?.slot) throw new Error(MESSAGE.FillUsage);
  if (!existsSync(path.join(dir, VEGETATION_MEMBERS[0]))) throw new Error(MESSAGE.NoTrunk(dir));
  const pack = new PackWriter(out, catalog.pack.version, id);
  let triangles = 0;
  const members: string[] = [];
  for (const member of VEGETATION_MEMBERS) {
    if (!existsSync(path.join(dir, member))) continue;
    const bytes = new Uint8Array(await readFile(path.join(dir, member)));
    triangles += glbTriangles(bytes);
    members.push(await pack.add(member, (await withLevels(bytes)).bytes));
  }
  await pack.facts(modelFacts(entry, members, triangles));
  entry.build = { pack: catalog.pack.version, files: pack.files, triangles };
  await writeCatalog(catalog);
}

async function previews(renders: string, out: string): Promise<void> {
  const catalog = await readCatalog();
  for (const name of await readdir(renders)) {
    const entry = catalog.entries.find((known) => `${packFileName(known.id, "")}png` === name);
    if (!entry?.build) continue;
    const image = await decodeImage(new Uint8Array(await readFile(path.join(renders, name))));
    const bytes = await previewJpeg(image);
    await mkdir(path.join(out, entry.build.pack), { recursive: true });
    await writeFile(path.join(out, entry.build.pack, packFileName(entry.id, "preview.jpg")), bytes);
    const files = entry.build.files.filter((file) => file.name !== "preview.jpg");
    entry.build.files = [...files, { name: "preview.jpg", sha256: sha256(bytes), bytes: bytes.byteLength }];
  }
  await writeCatalog(catalog);
}

async function stage(
  assets: string,
  only: ReadonlySet<string> | null,
  tier: LibraryTier | undefined,
  out: string,
): Promise<void> {
  const catalog = await readCatalog();
  const storage = path.join(CACHE_DIR, "storage");
  const net = { download: () => Promise.reject(new Error("stage reads the local pack only")) };
  for (const entry of catalog.entries) {
    if (!entry.build || (only && !only.has(entry.id))) continue;
    const asked = entry.kind === LibraryKind.Model || entry.kind === LibraryKind.Vegetation ? undefined : tier;
    const staged = await stageDelivery(
      catalog,
      { id: entry.id, ...(asked ? { tier: asked } : {}) },
      storage,
      { folder: out },
      net,
    );
    const target = path.join(assets, "library", libraryFolder(entry.id));
    await mkdir(target, { recursive: true });
    for (const file of staged.files) await copyFile(path.join(staged.staged, file.name), path.join(target, file.name));
    await rm(staged.staged, { recursive: true, force: true });
    console.log(MESSAGE.Staged(entry.id, target));
  }
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { only: { type: "string" }, tiers: { type: "string" }, tier: { type: "string" }, out: { type: "string" } },
  });
  const [command, argument = ""] = positionals;
  const only = values.only
    ? new Set(values.only.split(",").flatMap((id) => (id === "starter" ? STARTER_IDS : [id])))
    : null;
  const out = path.resolve(values.out ?? PACK_DIR);
  const tiers = (values.tiers?.split(",") ?? [LibraryTier.TwoK, LibraryTier.FourK]) as LibraryTier[];
  if (command === "pin") return pin(only);
  if (command === "build") return build(only, tiers, out);
  if (command === "fill") return fill(argument, out);
  if (command === "previews") return previews(path.resolve(argument), out);
  if (command === "stage") return stage(path.resolve(argument), only, values.tier as LibraryTier | undefined, out);
  console.error("usage: build-library.ts pin|build|fill|previews|stage (see the header)");
  process.exitCode = 2;
}

await main();
