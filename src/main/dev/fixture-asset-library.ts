/**
 * The asset library in a fixture launch: a few made-up generations in the fixture account's library,
 * answered in the same shapes genex.games answers them, so Save, Share, stop sharing, search and Add
 * can be checked with no socket. Saves and shares last the launch; signed out answers 401. A share
 * named with "refuse" is refused by the check; one named with "slow" is still being checked when it
 * answers, and is live by the next read.
 * Downloads are files made here: a one-triangle model, a short tone, a gradient picture. Like most of
 * a real library, a few generations list no thumbnail: their tiles draw their own pictures, and the
 * asset-library launch's window gets their files from here too (`fixtureFileResponse`).
 */
import { LibraryFileMiss } from "../../shared/asset-library.ts";
import { DownloadRefused } from "../play/asset-library.ts";
import type { GalleryAnswer, GalleryRequest } from "../play/gallery.ts";
import { gradientShot, type Rgb } from "./fixture-kit.ts";
import { fixtureAccountOf } from "./fixture-people.ts";

const OK = 200;
const CREATED = 201;
const BAD_REQUEST = 400;
const UNAUTHORIZED = 401;
const FORBIDDEN = 403;
const NOT_FOUND = 404;
/** A share whose name has this word is refused, so the refusal can be seen. */
const REFUSED_WORD = "refuse";
/** A share whose name has this word is still being checked when it answers, and live by the next read. */
const CHECKING_WORD = "slow";
const ACCEPTED = 202;
const FILE_HOST = "https://assets.genex.technology";

/** One made-up generation. */
interface FixtureGeneration {
  id: string;
  kind: "model" | "image" | "sfx" | "video";
  prompt: string;
  hue: number;
  savedAt: string | null;
  shared: { projectId: string; slug: string; status: "published" | "draft" } | null;
  provider: string;
  createdAt: string;
  /** genex.games lists no thumbnail for it, as for most of a real library. */
  noThumbnail?: true;
  /** A picture's colours, top to bottom; the moss wall's greens otherwise. */
  colors?: readonly [Rgb, Rgb];
}

/** The generation ids the fixture's games link their files to. */
export const FixtureGenerationId = {
  Mushroom: "fxgen-mushroom-tree-0001",
  Strider: "fxgen-silt-strider-0002",
  Hut: "fxgen-chitin-hut-0003",
  Crowd: "fxgen-stadium-crowd-0004",
  Moss: "fxgen-moss-wall-0005",
  Lantern: "fxgen-iron-lantern-0006",
  Dusk: "fxgen-dusk-sky-0007",
  Sword: "fxgen-bone-sword-0008",
  Wind: "fxgen-desert-wind-0009",
} as const;

const SEED: readonly FixtureGeneration[] = [
  {
    id: FixtureGenerationId.Dusk,
    kind: "image",
    prompt: "Desert sky at dusk",
    hue: 20,
    savedAt: null,
    shared: null,
    provider: "genex",
    createdAt: "2026-10-18T09:00:00.000Z",
    noThumbnail: true,
    colors: [
      [58, 46, 92],
      [236, 140, 84],
    ],
  },
  {
    id: FixtureGenerationId.Sword,
    kind: "model",
    prompt: "Bone sword with a curved blade",
    hue: 200,
    savedAt: null,
    shared: null,
    provider: "genex",
    createdAt: "2026-10-18T08:00:00.000Z",
    noThumbnail: true,
  },
  {
    id: FixtureGenerationId.Wind,
    kind: "sfx",
    prompt: "Desert wind over dunes",
    hue: 30,
    savedAt: null,
    shared: null,
    provider: "genex",
    createdAt: "2026-10-18T07:00:00.000Z",
    noThumbnail: true,
  },
  {
    id: FixtureGenerationId.Mushroom,
    kind: "model",
    prompt: "Giant mushroom tree with a tall twisted stem",
    hue: 18,
    savedAt: null,
    shared: null,
    provider: "genex",
    createdAt: "2026-10-17T09:00:00.000Z",
  },
  {
    id: FixtureGenerationId.Strider,
    kind: "model",
    prompt: "Silt strider, a giant insect mount",
    hue: 35,
    savedAt: "2026-10-16T12:00:00.000Z",
    shared: null,
    provider: "genex",
    createdAt: "2026-10-16T11:00:00.000Z",
  },
  {
    id: FixtureGenerationId.Hut,
    kind: "model",
    prompt: "Chitin hut with a round door",
    hue: 40,
    savedAt: null,
    shared: { projectId: "fxproj-chitin-hut", slug: "chitin-hut", status: "published" },
    provider: "genex",
    createdAt: "2026-10-15T10:00:00.000Z",
  },
  {
    id: FixtureGenerationId.Crowd,
    kind: "sfx",
    prompt: "Stadium crowd erupting after a goal",
    hue: 210,
    savedAt: "2026-10-14T10:00:00.000Z",
    shared: null,
    provider: "genex",
    createdAt: "2026-10-14T09:00:00.000Z",
  },
  {
    id: FixtureGenerationId.Moss,
    kind: "image",
    prompt: "Mossy stone wall texture",
    hue: 120,
    savedAt: null,
    shared: null,
    provider: "genex",
    createdAt: "2026-10-13T09:00:00.000Z",
  },
  {
    id: FixtureGenerationId.Lantern,
    kind: "model",
    prompt: "Iron street lantern on a post",
    hue: 48,
    savedAt: "2026-10-12T09:00:00.000Z",
    shared: null,
    provider: "genex",
    createdAt: "2026-10-12T08:00:00.000Z",
  },
];

/** The launch's library: the seed, then whatever this launch saved, sent or shared. */
const library = new Map<string, FixtureGeneration>(SEED.map((row) => [row.id, { ...row }]));
let made = 0;

/** genex.games' `type` filter: which generation kinds each type lists. */
const KINDS_OF_TYPE: Readonly<Record<string, readonly string[]>> = {
  "3d": ["model"],
  image: ["image"],
  sound: ["sfx"],
  video: ["video"],
};

/** The file role genex.games keeps each kind under. */
const ROLE_OF_KIND: Readonly<Record<FixtureGeneration["kind"], string>> = {
  model: "model-glb",
  image: "image-main",
  sfx: "audio-sfx",
  video: "video-mp4",
};

/** The kind an import's content type makes. */
const KIND_OF_TYPE: Readonly<Record<string, FixtureGeneration["kind"]>> = {
  "model/gltf-binary": "model",
  "image/png": "image",
  "image/jpeg": "image",
  "image/webp": "image",
  "audio/mpeg": "sfx",
  "audio/wav": "sfx",
  "audio/ogg": "sfx",
  "video/mp4": "video",
};

const EXTENSION_OF_KIND: Readonly<Record<FixtureGeneration["kind"], string>> = {
  model: "glb",
  image: "png",
  sfx: "wav",
  video: "mp4",
};

/** The content type each kind's made-up file is served as. */
const CONTENT_TYPE_OF_KIND: Readonly<Record<FixtureGeneration["kind"], string>> = {
  model: "model/gltf-binary",
  image: "image/png",
  sfx: "audio/wav",
  video: "video/mp4",
};

/** The moss wall's greens, top to bottom: a picture's colours unless its row names its own. */
const MOSS_COLORS: readonly [Rgb, Rgb] = [
  [40, 90, 50],
  [120, 160, 110],
];
/** The most a file served to the window may be; every made-up file is far smaller. */
const SERVED_MAX_BYTES = 1024 * 1024;

/** A drawn thumbnail in the generation's hue: a soft floor and a shape for its kind. */
function thumbnail(row: FixtureGeneration): string {
  const shape =
    row.kind === "sfx"
      ? Array.from({ length: 24 }, (_, i) => {
          const h = 6 + Math.round(26 * Math.abs(Math.sin(i * 0.7)) * (1 - i / 30));
          return `<rect x="${40 + i * 5}" y="${60 - h / 2}" width="3" height="${h}" rx="1.5" fill="hsl(${row.hue} 20% 80%)"/>`;
        }).join("")
      : `<ellipse cx="100" cy="88" rx="38" ry="7" fill="#000" opacity=".35"/><path d="M100 22 L132 82 L68 82 Z" fill="hsl(${row.hue} 55% 55%)"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 112"><defs><radialGradient id="g" cx=".5" cy=".4" r=".8"><stop offset="0" stop-color="#2d3036"/><stop offset="1" stop-color="#16171a"/></radialGradient></defs><rect width="200" height="112" fill="url(#g)"/>${shape}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** A slug for a shared name: lowercase words joined by dashes. */
const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "asset";

/** A generation as genex.games' list answers it. */
function view(row: FixtureGeneration) {
  const role = ROLE_OF_KIND[row.kind];
  return {
    id: row.id,
    kind: row.kind,
    provider: row.provider,
    status: "completed",
    prompt: row.prompt,
    thumbnailUrl: row.noThumbnail ? null : thumbnail(row),
    files: [
      {
        role,
        ext: EXTENSION_OF_KIND[row.kind],
        url: `${FILE_HOST}/generations/${row.id}/${slugOf(row.prompt)}.${EXTENSION_OF_KIND[row.kind]}`,
      },
    ],
    savedAt: row.savedAt,
    hiddenAt: null,
    createdAt: row.createdAt,
    sharedAsset: row.shared,
  };
}

const ok = (body: unknown): GalleryAnswer => ({ status: OK, body });
const refused = (status: number, error: string): GalleryAnswer => ({ status, body: { error } });

/** A page of the library for the list route's query. */
function list(query: URLSearchParams): GalleryAnswer {
  const words = (query.get("q") ?? "").toLowerCase();
  const kinds = KINDS_OF_TYPE[query.get("type") ?? ""];
  const ids = query.get("ids")?.split(",");
  const rows = [...library.values()]
    .filter((row) => !words || row.prompt.toLowerCase().includes(words))
    .filter((row) => !kinds || kinds.includes(row.kind))
    .filter((row) => query.get("saved") !== "1" || row.savedAt !== null)
    .filter((row) => !ids || ids.includes(row.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return ok({ generations: rows.map(view), nextCursor: null });
}

/** Share a generation under `name`; a name with the refused word is refused by the check. */
function share(row: FixtureGeneration, body: unknown): GalleryAnswer {
  const name = typeof (body as { name?: unknown })?.name === "string" ? (body as { name: string }).name : row.prompt;
  if (name.toLowerCase().includes(REFUSED_WORD)) {
    return {
      status: FORBIDDEN,
      body: { error: "moderation_refused", category: "other", detail: "This can't go on Play." },
    };
  }
  if (row.provider === "upload") return refused(BAD_REQUEST, "upload_not_shareable");
  if (name.toLowerCase().includes(CHECKING_WORD)) {
    row.shared = { projectId: `fxproj-${slugOf(name)}`, slug: slugOf(name), status: "published" };
    return { status: ACCEPTED, body: { status: "pending" } };
  }
  // genex.games puts a page it took off Play back, and answers the page it has: one page per asset.
  if (row.shared) row.shared.status = "published";
  if (row.shared?.status === "published")
    return ok({ ...row.shared, title: name, worldUrl: `https://genex.games/world/${row.shared.slug}` });
  const slug = slugOf(name);
  row.shared = { projectId: `fxproj-${slug}`, slug, status: "published" };
  return {
    status: CREATED,
    body: { slug, title: name, worldUrl: `https://genex.games/world/${slug}`, projectId: row.shared.projectId },
  };
}

/** A shared page's status set by unpublish or publish. */
function setPage(projectId: string, status: "published" | "draft"): GalleryAnswer {
  const row = [...library.values()].find((entry) => entry.shared?.projectId === projectId);
  if (!row?.shared) return refused(NOT_FOUND, "not_found");
  row.shared.status = status;
  return ok({ project: { id: projectId, slug: row.shared.slug, status } });
}

/** Start sending a file to the library. */
function startImport(body: unknown): GalleryAnswer {
  const raw = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const kind = KIND_OF_TYPE[String(raw.contentType)];
  if (!kind) return refused(BAD_REQUEST, "invalid_content_type");
  made += 1;
  const id = `fxgen-sent-${String(made).padStart(4, "0")}`;
  const title = typeof raw.title === "string" && raw.title ? raw.title : `Imported ${String(raw.filename)}`;
  library.set(id, {
    id,
    kind,
    prompt: title,
    hue: (made * 67) % 360,
    savedAt: raw.save === true ? new Date().toISOString() : null,
    shared: null,
    provider: "upload",
    createdAt: new Date().toISOString(),
  });
  return ok({ id, uploadUrl: `https://fixture.invalid/upload/${id}`, url: `${FILE_HOST}/generations/${id}` });
}

/** A shared page's route: its project id and whether it is put on Play or taken off. */
const PAGE_ROUTE = /^\/api\/projects\/([^/]+)\/(unpublish|publish)$/;
const DONE_ROUTE = /^\/api\/generations\/import\/([^/]+)\/complete$/;
const ONE_ROUTE = /^\/api\/generations\/([^/]+)(\/publish-asset)?$/;

/** A route on one generation: a share, a Saved mark, or a read. */
function generationAnswer(pathname: string, init: Parameters<GalleryRequest>[1]): GalleryAnswer {
  const done = DONE_ROUTE.exec(pathname);
  if (done) return library.has(decodeURIComponent(done[1] ?? "")) ? ok({}) : refused(NOT_FOUND, "not_found");
  const one = ONE_ROUTE.exec(pathname);
  const row = one ? library.get(decodeURIComponent(one[1] ?? "")) : undefined;
  if (!row) return refused(NOT_FOUND, "not_found");
  if (one?.[2]) return share(row, init.body);
  const saved = init.method === "PATCH" ? (init.body as { saved?: unknown } | undefined)?.saved : undefined;
  if (typeof saved === "boolean") row.savedAt = saved ? new Date().toISOString() : null;
  return ok({ generation: view(row) });
}

/**
 * The fixture's answer for a library route, or null for any other route. Every library route
 * needs the fixture account.
 */
export function fixtureLibraryAnswer(route: string, init: Parameters<GalleryRequest>[1]): GalleryAnswer | null {
  const [pathname = "", search = ""] = route.split("?");
  const page = PAGE_ROUTE.exec(pathname);
  if (!pathname.startsWith("/api/generations") && !page) return null;
  if (!fixtureAccountOf(init.token)) return { status: UNAUTHORIZED, body: { error: "unauthorized" } };
  if (page) return setPage(decodeURIComponent(page[1] ?? ""), page[2] === "publish" ? "published" : "draft");
  if (pathname === "/api/generations") return list(new URLSearchParams(search));
  if (pathname === "/api/generations/import") return startImport(init.body);
  return generationAnswer(pathname, init);
}

/** A one-triangle glTF binary in `hue`: the smallest model the canvas draws. */
export function triangleGlb(hue: number): Uint8Array {
  const positions = new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0, 0.9, 0]);
  const bin = Buffer.from(positions.buffer);
  const color = [0.4 + 0.4 * Math.cos((hue * Math.PI) / 180), 0.5, 0.4 + 0.4 * Math.sin((hue * Math.PI) / 180), 1];
  const json = JSON.stringify({
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: color }, doubleSided: true }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteLength: bin.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [-0.5, 0, 0], max: [0.5, 0.9, 0] }],
  });
  const jsonChunk = Buffer.from(json.padEnd(Math.ceil(json.length / 4) * 4, " "));
  const total = 12 + 8 + jsonChunk.length + 8 + bin.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  const chunk = (type: number, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(data.length, 0);
    head.writeUInt32LE(type, 4);
    return Buffer.concat([head, data]);
  };
  return Buffer.concat([header, chunk(0x4e4f534a, jsonChunk), chunk(0x004e4942, bin)]);
}

/** Half a second of a soft tone as 16-bit mono WAV. */
export function toneWav(): Uint8Array {
  const rate = 22050;
  const samples = rate / 2;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++)
    data.writeInt16LE(Math.round(6000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** The generation a file address names: `/generations/<id>/<name>`. */
const generationOfFile = (url: URL): string => /\/generations\/([^/]+)\//.exec(url.pathname)?.[1] ?? "";

/** A fixture launch's download: the made-up file for the generation the address names. */
export async function fixtureDownload(url: string, maxBytes: number): Promise<Uint8Array> {
  const row = library.get(generationOfFile(new URL(url)));
  const bytes = (() => {
    if (row?.kind === "sfx") return toneWav();
    if (row?.kind === "image") return gradientShot(...(row.colors ?? MOSS_COLORS));
    return triangleGlb(row?.hue ?? 200);
  })();
  if (bytes.byteLength > maxBytes)
    throw new DownloadRefused(LibraryFileMiss.TooLarge, "That file is too large to add.");
  return bytes;
}

/**
 * What the asset-library launch's window gets for one of the fixture library's file addresses (the
 * picture a tile shows, the sound it plays): the made-up file, so no socket opens. Null for any other
 * address.
 */
export async function fixtureFileResponse(url: string): Promise<Response | null> {
  const address = URL.canParse(url) ? new URL(url) : null;
  const row = address?.origin === FILE_HOST ? library.get(generationOfFile(address)) : undefined;
  if (!row) return null;
  const bytes = new Uint8Array(await fixtureDownload(url, SERVED_MAX_BYTES));
  return new Response(bytes, { headers: { "content-type": CONTENT_TYPE_OF_KIND[row.kind] } });
}
