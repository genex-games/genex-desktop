/**
 * The Genex account's asset library on genex.games: read it, save to it, send a file to it, and
 * share an asset to Play or stop sharing it. Electron-free like the gallery; every call carries the
 * account's token and a 401 reads as {@link SignInNeeded}.
 */
import {
  isGenerationId,
  isLibraryKind,
  LIBRARY_IDS_MAX,
  type LibraryFileAnswer,
  LibraryFileMiss,
  libraryFileUrl,
  LIBRARY_QUERY_MAX,
  type LibraryAsset,
  LibraryKind,
  type LibraryPage,
  type LibraryQuery,
  SHARE_NAME_MAX,
  type SharedAsset,
  ShareMiss,
} from "../../shared/asset-library.ts";
import { MINUTE_MS } from "../../shared/duration.ts";
import { ASSET_FORMATS, type AssetFormat, type AssetPreviewMode } from "../../shared/game-assets.ts";
import { t } from "../../shared/i18n.ts";
import { isPlaySlug } from "../../shared/play.ts";
import { GalleryError, type GalleryRequest, imageUrl, isRecord, SignInNeeded, text } from "./gallery.ts";
import type { PeopleDeps } from "./people.ts";

/** The routes the library calls. */
export const LibraryRoute = {
  List: "/api/generations",
  Import: "/api/generations/import",
  generation: (id: string) => `/api/generations/${encodeURIComponent(id)}`,
  share: (id: string) => `/api/generations/${encodeURIComponent(id)}/publish-asset`,
  importDone: (id: string) => `/api/generations/import/${encodeURIComponent(id)}/complete`,
  unshare: (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/unpublish`,
} as const;

const HTTP_UNAUTHORIZED = 401;
const HTTP_REDIRECT = 300;
const HTTP_CLIENT_ERROR = 400;
const HTTP_SERVER_ERROR = 500;
/** Client errors that say "not now" rather than "not this file": a timeout, too many requests. */
const HTTP_RETRY_LATER: ReadonlySet<number> = new Set([408, 429]);
const HTTP_ACCEPTED = 202;
const HTTP_FORBIDDEN = 403;
const HTTP_TOO_MANY = 429;
const TITLE_MAX = 300;
/** How long one library file may take to download. */
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** The most a tile's picture reads of one library file: a larger model keeps its glyph. */
export const LIBRARY_PICTURE_MAX_BYTES = 32 * 1024 * 1024;
/** How long reading one library file for a tile's picture may take. */
export const LIBRARY_PICTURE_TIMEOUT_MS = MINUTE_MS;
/**
 * How long Save's upload of one file may take: a file as large as Save sends, over a slow uplink.
 * An avatar's upload is a far smaller picture, and its wait would cut a large file off.
 */
export const LIBRARY_UPLOAD_TIMEOUT_MS = 10 * MINUTE_MS;
const ID_MAX = 64;
/** genex.games' wire status of a project on Play. */
const PUBLISHED = "published";

/**
 * A generation's own file, by the role genex.games stores it under, most wanted first, and what each
 * role holds: its kind, and its format when the role names one. Wire values.
 */
const MAIN_FILE_ROLES = [
  { role: "model-glb", kind: LibraryKind.Model, format: "glb" },
  { role: "image-main", kind: LibraryKind.Image, format: null },
  { role: "audio-sfx", kind: LibraryKind.Sound, format: null },
  { role: "video-mp4", kind: LibraryKind.Video, format: "mp4" },
] as const satisfies readonly (FileIs & { role: string })[];

/** The provider genex.games records for a file sent from a person's own Mac. Wire value. */
const UPLOAD_PROVIDER = "upload";
/** Generation kinds genex.games takes no shares of (music: its provider's terms). */
const UNSHAREABLE_KINDS: ReadonlySet<string> = new Set(["music"]);

/** genex.games' generation kinds by the library kind they file under (anything else is 3D). */
const KIND_OF_GENERATION: Readonly<Record<string, LibraryKind>> = {
  image: LibraryKind.Image,
  texture: LibraryKind.Image,
  sfx: LibraryKind.Sound,
  music: LibraryKind.Sound,
  voice: LibraryKind.Sound,
  video: LibraryKind.Video,
};

/** What the library needs: the gallery's request and token, and a presigned upload. */
export type LibraryDeps = Pick<PeopleDeps, "request" | "token" | "upload" | "localImages">;

/** A file to send to the library: its bytes, name and type, and the title it is saved under. */
export interface LibraryFile {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
  title: string;
}

/**
 * What a file is: its kind (null when nothing says, or it is no file a tile shows) and its format, the
 * extension it was found to be (null when nothing says).
 */
interface FileIs {
  kind: LibraryKind | null;
  format: string | null;
}

/** A generation's file and what it is. */
interface MainFile extends FileIs {
  url: string;
}

/**
 * A file's kind by the viewer the format table shows it in: a model, a picture an `<img>` shows, a
 * sound, a video. A texture only the model viewer reads (HDR, EXR, KTX2) or an authoring file has none.
 */
const KIND_OF_PREVIEW: Readonly<Partial<Record<AssetPreviewMode, LibraryKind>>> = {
  model: LibraryKind.Model,
  image: LibraryKind.Image,
  audio: LibraryKind.Sound,
  video: LibraryKind.Video,
};

/** What the format at `ext` in the format table is. */
const formatIs = (ext: string, format: AssetFormat): FileIs => ({
  kind: KIND_OF_PREVIEW[format.preview] ?? null,
  format: ext,
});

/**
 * What a content type names: the first format of its type in table order, when every format of that
 * type is of one kind; undefined when it names none, or formats of several kinds (`application/octet-stream`).
 */
function typeIs(value: unknown): FileIs | undefined {
  if (typeof value !== "string") return undefined;
  const type = value.split(";")[0]?.trim().toLowerCase() ?? "";
  const named = Object.entries(ASSET_FORMATS)
    .filter(([, format]) => format.mime === type)
    .map(([ext, format]) => formatIs(ext, format));
  return new Set(named.map((is) => is.kind)).size === 1 ? named[0] : undefined;
}

/** What an extension (`glb`, `.GLB`) names, or undefined for one the format table does not know. */
function extensionIs(value: unknown): FileIs | undefined {
  if (typeof value !== "string") return undefined;
  const ext = value.replace(/^\./, "").toLowerCase();
  const format = Object.hasOwn(ASSET_FORMATS, ext) ? ASSET_FORMATS[ext] : undefined;
  return format ? formatIs(ext, format) : undefined;
}

/**
 * What a listed file is, by the first that names a kind: its content type, its row's `ext`, its
 * address's extension (genex.games' addresses often end in a role name). When none names a kind, the
 * first format any names stands (a GPU texture is no picture, whatever its role); when none names a
 * format, its role says.
 */
function fileIs(file: Record<string, unknown>, url: string, role: FileIs): FileIs {
  const name = new URL(url).pathname.split("/").at(-1) ?? "";
  const addressExt = name.includes(".") ? name.split(".").at(-1) : undefined;
  const named = [typeIs(file.contentType), extensionIs(file.ext), extensionIs(addressExt)].filter(
    (is) => is !== undefined,
  );
  return named.find((is) => is.kind !== null) ?? named[0] ?? { kind: role.kind, format: role.format };
}

/** What a file of no main role is when nothing about it says. */
const UNKNOWN_FILE: FileIs = { kind: null, format: null };

/**
 * The file genex.games keeps a generation as, and what it is: its main role's, else the first with
 * an address (a model's preview picture, when the model itself is off the asset hosts).
 */
function mainFile(files: unknown): MainFile | null {
  const list = Array.isArray(files) ? files.filter(isRecord) : [];
  for (const role of MAIN_FILE_ROLES) {
    const file = list.find((row) => row.role === role.role);
    const url = libraryFileUrl(file?.url);
    if (file && url) return { url, ...fileIs(file, url, role) };
  }
  for (const file of list) {
    const url = libraryFileUrl(file.url);
    if (url) return { url, ...fileIs(file, url, UNKNOWN_FILE) };
  }
  return null;
}

/** A generation's shared page, when it has one. */
function sharedOf(value: unknown): SharedAsset | null {
  if (!isRecord(value)) return null;
  const projectId = text(value.projectId, ID_MAX);
  if (!projectId || !isPlaySlug(value.slug)) return null;
  // genex.games says whether the public sees the page (`live`: not held, not taken down); an older
  // answer has only the project's status.
  const live = typeof value.live === "boolean" ? value.live : value.status === PUBLISHED;
  return { projectId, slug: value.slug, live };
}

/** One listed generation as the app keeps it, or null when it lacks what a card needs. */
export function toLibraryAsset(item: unknown, local = false): LibraryAsset | null {
  if (!isRecord(item) || !isGenerationId(item.id)) return null;
  const kind = typeof item.kind === "string" ? (KIND_OF_GENERATION[item.kind] ?? LibraryKind.Model) : LibraryKind.Model;
  const createdAt = typeof item.createdAt === "string" ? item.createdAt : "";
  const file = mainFile(item.files);
  return {
    id: item.id,
    kind,
    title: text(item.prompt, TITLE_MAX).split("\n")[0]?.trim() ?? "",
    thumbnailUrl: imageUrl(item.thumbnailUrl, local),
    fileUrl: file?.url ?? null,
    fileKind: file?.kind ?? null,
    fileFormat: file?.format ?? null,
    saved: typeof item.savedAt === "string",
    shared: sharedOf(item.sharedAsset),
    shareable: item.provider !== UPLOAD_PROVIDER && !UNSHAREABLE_KINDS.has(String(item.kind)),
    createdAt,
  };
}

/** The list route's query for `query`; anything malformed is left out rather than sent. */
export function libraryListRoute(query: LibraryQuery): string {
  const params = new URLSearchParams({ scope: "library" });
  const words = (query.query ?? "").trim().slice(0, LIBRARY_QUERY_MAX);
  if (words) params.set("q", words);
  if (isLibraryKind(query.kind)) params.set("type", query.kind);
  if (query.saved) params.set("saved", "1");
  const ids = (query.ids ?? []).filter(isGenerationId).slice(0, LIBRARY_IDS_MAX);
  if (ids.length > 0) params.set("ids", ids.join(","));
  if (isGenerationId(query.before)) params.set("before", query.before);
  return `${LibraryRoute.List}?${params}`;
}

/** A share's answer: the page on Play, or why there is none. */
export type ShareAnswer = { shared: SharedAsset } | { miss: ShareMiss; detail?: string };

/** A share's answer as the page it made, or why there is none. */
function shareAnswer(answer: { status: number; body: unknown }): ShareAnswer {
  if (answer.status < 200 || answer.status >= 300 || answer.status === HTTP_ACCEPTED) {
    return shareMiss(answer.status, answer.body);
  }
  const page = isRecord(answer.body) && isRecord(answer.body.project) ? answer.body.project : answer.body;
  const shared = sharedOf({ ...(isRecord(page) ? page : {}), status: PUBLISHED, projectId: projectIdOf(page) });
  return shared ? { shared } : { miss: ShareMiss.Failed };
}

/** The miss a refused share answers with. */
function shareMiss(status: number, body: unknown): { miss: ShareMiss; detail?: string } {
  const error = isRecord(body) && typeof body.error === "string" ? body.error : "";
  const detail = isRecord(body) ? text(body.detail, TITLE_MAX) : "";
  if (status === HTTP_ACCEPTED) return { miss: ShareMiss.Checking };
  if (status === HTTP_FORBIDDEN) return { miss: ShareMiss.Refused, ...(detail ? { detail } : {}) };
  if (status === HTTP_TOO_MANY) return { miss: ShareMiss.TooMany };
  if (error === "kind_not_publishable") return { miss: ShareMiss.KindNotShareable };
  if (error === "upload_not_shareable") return { miss: ShareMiss.NotShareable };
  // A share of this asset is still on its way (copied, then checked): it goes live on its own.
  if (error === "asset_share_in_progress") return { miss: ShareMiss.Checking };
  return { miss: ShareMiss.Failed };
}

/** The library's calls over `deps`. */
export function assetLibrary(deps: LibraryDeps) {
  const { request, token, upload } = deps;
  const local = deps.localImages === true;

  /** The account's token, or {@link SignInNeeded}. */
  const auth = async (): Promise<string> => {
    const current = await token();
    if (!current) throw new SignInNeeded();
    return current;
  };

  /** A call that throws on a 401 (sign-in) and on any other non-2xx; the body otherwise. */
  const call = async (route: string, init: Parameters<GalleryRequest>[1]): Promise<unknown> => {
    const answer = await request(route, { ...init, token: await auth() });
    if (answer.status === HTTP_UNAUTHORIZED) throw new SignInNeeded();
    if (answer.status < 200 || answer.status >= 300) throw new GalleryError(route, answer.status);
    return answer.body;
  };

  /** One page of the library, newest first. */
  const list = async (query: LibraryQuery = {}): Promise<LibraryPage> => {
    const body = await call(libraryListRoute(query), { method: "GET" });
    const rows = isRecord(body) && Array.isArray(body.generations) ? body.generations : [];
    const assets = rows.map((row) => toLibraryAsset(row, local)).filter((row) => row !== null);
    const next = isRecord(body) && isGenerationId(body.nextCursor) ? body.nextCursor : null;
    return { assets, nextCursor: next };
  };

  /** Mark a generation saved, or take the mark off. */
  const setSaved = async (id: string, saved: boolean): Promise<void> => {
    if (!isGenerationId(id)) throw new GalleryError(LibraryRoute.List, 400);
    await call(LibraryRoute.generation(id), { method: "PATCH", body: { saved } });
  };

  /**
   * Put a generation on Play under `name`. genex.games answers the page it has when the asset is on
   * Play already, and puts a page it took off Play back, so a share never makes a second page.
   */
  const share = async (id: string, name: string): Promise<ShareAnswer> => {
    if (!isGenerationId(id)) return { miss: ShareMiss.Failed };
    const body = { name: name.trim().slice(0, SHARE_NAME_MAX) };
    const answer = await request(LibraryRoute.share(id), { method: "POST", token: await auth(), body });
    if (answer.status === HTTP_UNAUTHORIZED) throw new SignInNeeded();
    return shareAnswer(answer);
  };

  /** Take a shared asset off Play. */
  const unshare = async (projectId: string): Promise<void> => {
    await call(LibraryRoute.unshare(projectId), { method: "POST" });
  };

  /** Send a file to the library, saved, and answer its generation id. */
  const send = async (file: LibraryFile): Promise<string> => {
    const body = {
      filename: file.filename,
      contentType: file.contentType,
      bytes: file.bytes.byteLength,
      title: file.title.trim().slice(0, SHARE_NAME_MAX),
      save: true,
    };
    const started = await call(LibraryRoute.Import, { method: "POST", body });
    const id = isRecord(started) ? started.id : undefined;
    const url = isRecord(started) && typeof started.uploadUrl === "string" ? started.uploadUrl : "";
    if (!isGenerationId(id) || !url.startsWith("https://")) throw new GalleryError(LibraryRoute.Import, 502);
    const status = await upload(url, file.bytes, file.contentType);
    if (status < 200 || status >= 300) throw new GalleryError(LibraryRoute.Import, status);
    await call(LibraryRoute.importDone(id), { method: "POST" });
    return id;
  };

  return { list, setSaved, share, unshare, send };
}

/** The project id a share's answer names, under either of the names genex.games uses. */
function projectIdOf(page: unknown): string {
  if (!isRecord(page)) return "";
  return text(page.projectId, ID_MAX) || text(page.id, ID_MAX);
}

/** A download of a library file: its bytes, at most `maxBytes`. */
export type LibraryDownload = (url: string, maxBytes: number) => Promise<Uint8Array>;

/** Why a download was refused, as the person reads it when Add fails. */
const DOWNLOAD_MESSAGE = {
  notOurs: () => t("That file isn't on genex.games."),
  tooLarge: () => t("That file is too large to add."),
  failed: (status: number) => t("genex.games answered {status} for that file.", { status }),
} as const;

/** A download refused for the file itself or by genex.games, and why; its words are the reason a person reads. */
export class DownloadRefused extends Error {
  readonly miss: LibraryFileMiss;
  constructor(miss: LibraryFileMiss, message: string) {
    super(message);
    this.miss = miss;
  }
}

/**
 * How an answer that brought no file reads: a redirect (never followed) or a 4xx is the file's own,
 * asked again, refused again; a 408, a 429, a 5xx and anything else may pass.
 */
function missOfAnswer(res: Response): LibraryFileMiss {
  const redirected = res.type === "opaqueredirect" || (res.status >= HTTP_REDIRECT && res.status < HTTP_CLIENT_ERROR);
  const refused =
    res.status >= HTTP_CLIENT_ERROR && res.status < HTTP_SERVER_ERROR && !HTTP_RETRY_LATER.has(res.status);
  return redirected || refused ? LibraryFileMiss.Refused : LibraryFileMiss.Unavailable;
}

/** Why a download failed: its refusal, or one that may pass (the network, a timeout). */
const missOf = (error: unknown): LibraryFileMiss =>
  error instanceof DownloadRefused ? error.miss : LibraryFileMiss.Unavailable;

/** A signal that aborts once `ms` passed (`AbortSignal.timeout`); a test hands in one it aborts itself. */
export type DownloadTimeout = (ms: number) => AbortSignal;

/**
 * The network download: only from genex.games' asset hosts, no redirects, never more than
 * `maxBytes` read (a lying or missing Content-Length is caught while reading), in a bounded wait.
 */
export function networkDownload(
  fetchImpl: typeof fetch,
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
  timeout: DownloadTimeout = (ms) => AbortSignal.timeout(ms),
): LibraryDownload {
  return async (url, maxBytes) => {
    const checked = libraryFileUrl(url);
    if (!checked) throw new DownloadRefused(LibraryFileMiss.Refused, DOWNLOAD_MESSAGE.notOurs());
    // A redirect is answered, not followed: it could lead off genex.games' hosts.
    const res = await fetchImpl(checked, { redirect: "manual", signal: timeout(timeoutMs) });
    // A body refused unread is cancelled, so its connection is let go of rather than left open.
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      throw new DownloadRefused(missOfAnswer(res), DOWNLOAD_MESSAGE.failed(res.status));
    }
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > maxBytes) {
      await res.body.cancel();
      throw new DownloadRefused(LibraryFileMiss.TooLarge, DOWNLOAD_MESSAGE.tooLarge());
    }
    return readCapped(res.body, maxBytes);
  };
}

/** A library file's bytes for a tile's picture, from any address the renderer names, or why there are none. */
export type LibraryPictureFile = (url: unknown) => Promise<LibraryFileAnswer>;

/**
 * A tile's picture file through `download`: only an https file on genex.games' asset hosts (checked
 * before anything is asked), at most {@link LIBRARY_PICTURE_MAX_BYTES}. A refusal is answered as its
 * code, since only an error's words cross IPC.
 */
export function libraryPictureFile(download: LibraryDownload): LibraryPictureFile {
  return async (url) => {
    const checked = libraryFileUrl(url);
    if (!checked) return { miss: LibraryFileMiss.Refused };
    try {
      return { bytes: new Uint8Array(await download(checked, LIBRARY_PICTURE_MAX_BYTES)) };
    } catch (error) {
      return { miss: missOf(error) };
    }
  };
}

/** A tile's picture file from genex.games' asset hosts over `fetchImpl`, in {@link LIBRARY_PICTURE_TIMEOUT_MS}. */
export function networkPictureFile(
  fetchImpl: typeof fetch,
  timeout: DownloadTimeout = (ms) => AbortSignal.timeout(ms),
): LibraryPictureFile {
  return libraryPictureFile(networkDownload(fetchImpl, LIBRARY_PICTURE_TIMEOUT_MS, timeout));
}

/** A body's bytes, refusing it the moment it passes `maxBytes`. */
async function readCapped(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new DownloadRefused(LibraryFileMiss.TooLarge, DOWNLOAD_MESSAGE.tooLarge());
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/** The library as `assetLibrary` makes it. */
export type AssetLibrary = ReturnType<typeof assetLibrary>;
