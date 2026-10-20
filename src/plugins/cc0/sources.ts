/**
 * Where CC0 assets come from and what one fetch downloads: a request (checked before anything is
 * asked of the network) becomes a plan of pinned downloads from Poly Haven's API, ambientCG's API
 * or the curated manifest. Every planned URL is checked against the download allowlist before the
 * first byte is fetched.
 */
import { Cc0Error, Cc0Refusal, CC0, checkedName } from "../../substrate/cc0-fetch.ts";
import { CURATED, type CuratedManifest } from "./curated.ts";
import { type Cc0Net, checkedHost, DOWNLOAD_HOSTS } from "./net.ts";

/** Where a fetch comes from. Wire values: the tools' `source` argument. */
export const Cc0Source = { PolyHaven: "polyhaven", AmbientCg: "ambientcg", Curated: "curated" } as const;
export type Cc0Source = (typeof Cc0Source)[keyof typeof Cc0Source];

/** Refusals the plugin adds to the fetch core's ({@link Cc0Refusal}). Wire values: never rename one. */
export const Cc0PluginRefusal = {
  /** The curated pack is listed but cannot be fetched yet; the detail names its `CuratedHeld` reason. */
  CuratedHeld: "curated-held",
} as const;

/** What an asset is. Wire values: the tools' `kind` argument. */
export const Cc0Kind = { Model: "model", Texture: "texture", Hdri: "hdri" } as const;
export type Cc0Kind = (typeof Cc0Kind)[keyof typeof Cc0Kind];

/**
 * A delivered file's role: a whole model, a sky map, or a map in Poly Haven's vocabulary (the
 * roles `PROVENANCE_ROLE_USAGE` reads for origin `cc0`). Wire values: never rename one.
 */
export const Cc0Map = {
  Model: "model",
  Hdri: "hdri",
  Diff: "diff",
  NorGl: "nor_gl",
  NorDx: "nor_dx",
  Arm: "arm",
  Rough: "rough",
  Ao: "ao",
  Metal: "metal",
  Disp: "disp",
} as const;
export type Cc0Map = (typeof Cc0Map)[keyof typeof Cc0Map];

/** The texture maps, in the order a plan lists them. */
const TEXTURE_MAPS: readonly Cc0Map[] = [
  Cc0Map.Diff,
  Cc0Map.NorGl,
  Cc0Map.NorDx,
  Cc0Map.Arm,
  Cc0Map.Rough,
  Cc0Map.Ao,
  Cc0Map.Metal,
  Cc0Map.Disp,
];
/** The maps a texture fetch delivers when none are named: colour, normal and packed AO/rough/metal. */
const POLYHAVEN_DEFAULT_MAPS: readonly Cc0Map[] = [Cc0Map.Diff, Cc0Map.NorGl, Cc0Map.Arm];
/** ambientCG ships no packed map: colour, normal, roughness, occlusion and metalness. */
const AMBIENTCG_DEFAULT_MAPS: readonly Cc0Map[] = [Cc0Map.Diff, Cc0Map.NorGl, Cc0Map.Rough, Cc0Map.Ao, Cc0Map.Metal];

/** Each map's key in Poly Haven's `/files` answer. */
const POLYHAVEN_FILE_KEY: Readonly<Record<string, string>> = {
  [Cc0Map.Diff]: "Diffuse",
  [Cc0Map.NorGl]: "nor_gl",
  [Cc0Map.NorDx]: "nor_dx",
  [Cc0Map.Arm]: "arm",
  [Cc0Map.Rough]: "Rough",
  [Cc0Map.Ao]: "AO",
  [Cc0Map.Metal]: "Metal",
  [Cc0Map.Disp]: "Displacement",
};
/** Each ambientCG map name (the last part of a zip member's name) and its role. */
const AMBIENTCG_MAP_ROLE: Readonly<Record<string, Cc0Map>> = {
  Color: Cc0Map.Diff,
  NormalGL: Cc0Map.NorGl,
  NormalDX: Cc0Map.NorDx,
  Roughness: Cc0Map.Rough,
  AmbientOcclusion: Cc0Map.Ao,
  Metalness: Cc0Map.Metal,
  Displacement: Cc0Map.Disp,
};
/** Poly Haven's asset `type` in `/info`: 0 an HDRI, 1 a texture, 2 a model. */
const POLYHAVEN_TYPE_KIND: readonly Cc0Kind[] = [Cc0Kind.Hdri, Cc0Kind.Texture, Cc0Kind.Model];

/** The resolutions a fetch may ask for (8k maps run to hundreds of megabytes). */
export const RESOLUTIONS: readonly string[] = ["1k", "2k", "4k"];
/** The largest single download a plan may hold. */
const MAX_FILE_BYTES = 512 * 1024 * 1024;

const POLYHAVEN_API = "https://api.polyhaven.com";
const AMBIENTCG_API = "https://ambientcg.com/api/v2/full_json";

/** A checked fetch request. */
export interface Cc0Request {
  source: Cc0Source;
  id: string;
  resolution: string | null;
  /** The maps named, or null for the source's default. */
  maps: Cc0Map[] | null;
}

/** One download: its plain name, URL, size, published md5 and sha256 pin (null: pinned on first fetch). */
export interface PlannedFile {
  name: string;
  url: string;
  bytes: number;
  md5?: string;
  sha256: string | null;
  map: string;
}

/** What one fetch downloads, and how its files become deliveries. */
export interface FetchPlan {
  source: Cc0Source;
  id: string;
  kind: Cc0Kind;
  resolution: string | null;
  page: string;
  authors: string[];
  /** Files delivered as downloaded. */
  files: PlannedFile[];
  /** A glTF and its resources (by the URI the glTF names), packed into the GLB `name`. */
  model?: { name: string; gltf: PlannedFile; resources: Array<PlannedFile & { uri: string }> };
  /** A zip whose members are delivered, each with the role `roleOf` gives its name (null: left out). */
  zip?: { file: PlannedFile; maps: readonly Cc0Map[]; roleOf: (member: string) => Cc0Map | null };
}

const SOURCES: ReadonlySet<string> = new Set(Object.values(Cc0Source));
const TEXTURE_MAP_SET: ReadonlySet<string> = new Set(TEXTURE_MAPS);

function invalid(detail: string): Cc0Error {
  return new Cc0Error(Cc0Refusal.ManifestInvalid, detail);
}

function mapsOf(value: unknown): Cc0Map[] | null {
  if (value === undefined || value === "") return null;
  if (typeof value !== "string") throw invalid("maps is a comma-separated list");
  const names = value.split(",").map((name) => name.trim());
  const unknown = names.find((name) => !TEXTURE_MAP_SET.has(name));
  if (unknown !== undefined) throw invalid(`map ${JSON.stringify(unknown)}: one of ${TEXTURE_MAPS.join(", ")}`);
  return TEXTURE_MAPS.filter((map) => names.includes(map));
}

/** The request `args` make, or a refusal before anything reaches the network. */
export function checkedRequest(args: Record<string, unknown>): Cc0Request {
  const source = args.source;
  if (typeof source !== "string" || !SOURCES.has(source)) throw invalid(`source: one of ${[...SOURCES].join(", ")}`);
  if (typeof args.id !== "string") throw invalid("id is the asset's id");
  const id = checkedName(args.id);
  const maps = mapsOf(args.maps);
  if (source === Cc0Source.Curated) return { source, id, resolution: null, maps };
  const resolution = args.resolution ?? RESOLUTIONS[0];
  if (typeof resolution !== "string" || !RESOLUTIONS.includes(resolution)) {
    throw invalid(`resolution: one of ${RESOLUTIONS.join(", ")}`);
  }
  return { source: source as Cc0Source, id, resolution, maps };
}

/** A JSON object's field as an object, else null. */
function objectAt(value: unknown, key: string): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "object" && field !== null && !Array.isArray(field)
    ? (field as Record<string, unknown>)
    : null;
}

/** An API's file entry (`{url, size, md5?}`) as a planned download named after its URL's last part. */
function plannedFrom(entry: Record<string, unknown> | null, map: string, what: string): PlannedFile {
  const url = entry?.url;
  const bytes = entry?.size;
  const sized = typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes > 0 && bytes <= MAX_FILE_BYTES;
  if (typeof url !== "string" || !sized) throw invalid(`${what}: no file at this resolution`);
  const parsed = checkedHost(url, DOWNLOAD_HOSTS);
  const md5 = typeof entry?.md5 === "string" ? entry.md5 : undefined;
  const name = checkedName(decodeURIComponent(parsed.pathname.slice(parsed.pathname.lastIndexOf("/") + 1)));
  return { name, url, bytes, sha256: null, map, ...(md5 ? { md5 } : {}) };
}

function polyHavenAuthors(info: unknown): string[] {
  return Object.keys(objectAt(info, "authors") ?? {}).sort();
}

function polyHavenMaps(files: unknown, request: Cc0Request, maps: readonly Cc0Map[]): PlannedFile[] {
  const resolution = request.resolution ?? "";
  return maps.map((map) => {
    const key = POLYHAVEN_FILE_KEY[map] ?? "";
    return plannedFrom(objectAt(objectAt(objectAt(files, key), resolution), "jpg"), map, `${request.id} ${map}`);
  });
}

function polyHavenModel(files: unknown, request: Cc0Request): NonNullable<FetchPlan["model"]> {
  const resolution = request.resolution ?? "";
  const entry = objectAt(objectAt(objectAt(files, "gltf"), resolution), "gltf");
  const gltf = plannedFrom(entry, Cc0Map.Model, `${request.id} gltf`);
  const include = objectAt(entry, "include") ?? {};
  const resources = Object.entries(include).map(([uri, value]) => {
    const planned = plannedFrom(typeof value === "object" ? (value as Record<string, unknown>) : null, uri, uri);
    return { ...planned, uri };
  });
  return { name: checkedName(`${request.id}_${resolution}.glb`), gltf, resources };
}

/** Poly Haven's plan: a model packed into a GLB (plus any maps named), a texture's maps, or an HDRI. */
async function polyHavenPlan(request: Cc0Request, net: Cc0Net): Promise<FetchPlan> {
  const info = await net.json(new URL(`${POLYHAVEN_API}/info/${request.id}`));
  const type = (info as { type?: unknown } | null)?.type;
  const kind = typeof type === "number" ? POLYHAVEN_TYPE_KIND[type] : undefined;
  if (!kind) throw invalid(`${request.id}: Poly Haven lists no such asset`);
  const files = await net.json(new URL(`${POLYHAVEN_API}/files/${request.id}`));
  const base = {
    source: request.source,
    id: request.id,
    kind,
    resolution: request.resolution,
    page: `https://polyhaven.com/a/${request.id}`,
    authors: polyHavenAuthors(info),
  };
  if (kind === Cc0Kind.Hdri) {
    const entry = objectAt(objectAt(objectAt(files, "hdri"), request.resolution ?? ""), "hdr");
    return { ...base, files: [plannedFrom(entry, Cc0Map.Hdri, `${request.id} hdri`)] };
  }
  if (kind === Cc0Kind.Texture) {
    return { ...base, files: polyHavenMaps(files, request, request.maps ?? POLYHAVEN_DEFAULT_MAPS) };
  }
  return { ...base, files: polyHavenMaps(files, request, request.maps ?? []), model: polyHavenModel(files, request) };
}

interface AmbientDownload {
  fullDownloadPath?: unknown;
  fileName?: unknown;
  size?: unknown;
  attribute?: unknown;
}

/** The role of an ambientCG zip member named `<id>_<attribute>_<Map>.<ext>`, else null. */
function ambientRole(id: string, attribute: string): (member: string) => Cc0Map | null {
  const prefix = `${id}_${attribute}_`;
  return (member) => {
    if (!member.startsWith(prefix)) return null;
    const rest = member.slice(prefix.length);
    const map = rest.slice(0, rest.lastIndexOf("."));
    return Object.hasOwn(AMBIENTCG_MAP_ROLE, map) ? (AMBIENTCG_MAP_ROLE[map] ?? null) : null;
  };
}

/** ambientCG's plan: one material's zip at the resolution's JPEG attribute, its maps unpacked. */
async function ambientPlan(request: Cc0Request, net: Cc0Net): Promise<FetchPlan> {
  const query = new URLSearchParams({ id: request.id, include: "downloadData" });
  const listing = await net.json(new URL(`${AMBIENTCG_API}?${query}`));
  const found = (listing as { foundAssets?: unknown } | null)?.foundAssets;
  const asset = Array.isArray(found) ? found.find((item) => item?.assetId === request.id) : undefined;
  if (asset?.dataType !== "Material") throw invalid(`${request.id}: ambientCG lists no such material`);
  const attribute = `${(request.resolution ?? "").toUpperCase()}-JPG`;
  const zipCategory = objectAt(objectAt(objectAt(asset, "downloadFolders"), "default"), "downloadFiletypeCategories");
  const downloads = objectAt(zipCategory, "zip")?.downloads;
  const download = (Array.isArray(downloads) ? downloads : []).find(
    (item: AmbientDownload) => item?.attribute === attribute,
  ) as AmbientDownload | undefined;
  const file = plannedFrom(
    download ? { url: download.fullDownloadPath, size: download.size } : null,
    "zip",
    `${request.id} ${attribute}`,
  );
  return {
    source: request.source,
    id: request.id,
    kind: Cc0Kind.Texture,
    resolution: request.resolution,
    page: `https://ambientcg.com/a/${request.id}`,
    authors: ["ambientCG"],
    files: [],
    zip: { file, maps: request.maps ?? AMBIENTCG_DEFAULT_MAPS, roleOf: ambientRole(request.id, attribute) },
  };
}

/** A curated pack's plan: its pinned files, or a `curated-held` refusal with the pack's reason. */
function curatedPlan(request: Cc0Request, manifest: CuratedManifest): FetchPlan {
  const held = manifest.held.find((row) => row.id === request.id);
  if (held) throw new Cc0Error(Cc0PluginRefusal.CuratedHeld, `${held.id} ${held.reason}`);
  const asset = manifest.assets.find((row) => row.id === request.id);
  if (!asset) throw invalid(`${request.id}: no curated pack has this id`);
  if (asset.licence !== CC0) throw new Cc0Error(Cc0Refusal.NotCc0, `${asset.id}: ${asset.licence}`);
  const files = asset.files.map((entry) => {
    checkedHost(entry.url, DOWNLOAD_HOSTS);
    return { name: checkedName(entry.name), url: entry.url, bytes: entry.bytes, sha256: entry.sha256, map: entry.map };
  });
  const kind = Object.values(Cc0Kind).find((value) => value === asset.kind) ?? Cc0Kind.Model;
  return {
    source: request.source,
    id: asset.id,
    kind,
    resolution: null,
    page: asset.page,
    authors: asset.authors,
    files,
  };
}

/** The plan for `request`, every URL in it checked against the allowlist. */
export async function planFetch(
  request: Cc0Request,
  net: Cc0Net,
  curated: CuratedManifest = CURATED,
): Promise<FetchPlan> {
  if (request.source === Cc0Source.Curated) return curatedPlan(request, curated);
  if (request.source === Cc0Source.AmbientCg) return ambientPlan(request, net);
  return polyHavenPlan(request, net);
}
