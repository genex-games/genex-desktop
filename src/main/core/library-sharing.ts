/**
 * A game's assets and the person's genex.games library: where each file stands (saved, shared),
 * Save and Share on the game's own files, and bringing a library or shared asset into the game.
 *
 * A Genex asset is in the library already (its job names the generation). Saving any other file
 * sends it there first; the game remembers which generation each such file became in
 * `.studio/library-links.json` (ignored by git, builds and Publish). Nothing here trusts a file
 * name the renderer sends: each is checked against the game's own asset list first.
 */
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  type AddOutcome,
  type AddSource,
  type AssetLibraryState,
  type GameLibraryStates,
  isGenerationId,
  isSendable,
  sendMaxBytes,
  LIBRARY_IDS_MAX,
  type LibraryAsset,
  LibraryKind,
  libraryFileUrl,
  libraryKindOf,
  type ShareItem,
  ShareMiss,
  type ShareOutcome,
} from "../../shared/asset-library.ts";
import { assetKind, type ProjectAsset, type ProjectAssets } from "../../shared/game-assets.ts";
import { t } from "../../shared/i18n.ts";
import { isPlaySlug } from "../../shared/play.ts";
import { atomicWriteJson, createFileInDir, ensureDirBelow, readRegularFile } from "../../substrate/fsx.ts";
import type { AssetLibrary, ShareAnswer } from "../play/asset-library.ts";

/** Where a game keeps which generation each saved or added file is. */
const LINKS_FILE = ["library-links.json"] as const;
const STUDIO_DIR = ".studio";
/** The folders added assets land in, below `assets/`: one per source, one per add. */
export const AddFolder = { Library: "library", Community: "community" } as const;
/** The largest file Save sends or Add downloads. */
export const LIBRARY_FILE_MAX_BYTES = 64 * 1024 * 1024;
/** The largest links file read: thousands of links, far below anything that could stall a read. */
const LINKS_MAX_BYTES = 1024 * 1024;
/** A downloaded file's name: letters, digits, dot, dash, underscore, one extension. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** A shared asset manifest's `media` by the library kind it is. */
const MEDIA_KIND: Readonly<Record<string, LibraryKind>> = {
  glb: LibraryKind.Model,
  image: LibraryKind.Image,
  audio: LibraryKind.Sound,
  video: LibraryKind.Video,
};

/** A generation id no generation has: the read that proves the account and genex.games' id filter. */
const PROBE_GENERATION_ID = "probe-no-generation";

/** What the person reads in the Assets tab when Save, Share or Add is refused. */
const MESSAGE = {
  notInGame: () => t("That file isn't one of this game's assets."),
  olderLibrary: () => t("genex.games can't save or share from the app yet."),
  notFound: () => t("That asset isn't in your library."),
  noFile: () => t("genex.games has no file for that asset."),
  notWebGame: () => t("Code assets are for web games."),
  notSendable: () =>
    t(
      "genex.games takes GLB, PNG, JPEG, WebP, MP3, WAV, OGG and MP4 files, pictures and sounds up to 32 MB, models and videos up to 64 MB.",
    ),
} as const;

/** The library has no such generation (deleted, or never this account's): nothing to add. */
export class NotInLibrary extends Error {
  constructor() {
    super(MESSAGE.notFound());
  }
}

/** One file a link remembers: the generation it became, and whether Genex made it. */
interface LibraryLink {
  generationId: string;
  /** Sent from this Mac by Save: Genex did not make it, so it can't be shared. */
  sent: boolean;
}

/** `.studio/library-links.json`. */
interface LinksFile {
  version: 1;
  files: Record<string, LibraryLink>;
}

/** What the sharing needs from the core and the network. */
export interface LibrarySharingDeps {
  library(): AssetLibrary;
  /** A game's folder by its library name; rejects a game the launch's project policy refuses. */
  gameDir(project: string): Promise<string>;
  /** Whether the game takes three.js code modules (a web game). */
  webGame(project: string): Promise<boolean>;
  /** The game's assets as the Assets tab lists them. */
  assets(project: string): Promise<ProjectAssets>;
  /** A game file's bytes, read without following links, at most `maxBytes`. */
  readFile(gameDir: string, file: string, maxBytes: number): Promise<{ mimeType: string; data: Uint8Array }>;
  /** A shared asset's manifest, as genex.games answers it. */
  manifest(slug: string): Promise<unknown>;
  /** A file from genex.games' asset hosts, at most `maxBytes`. */
  download(url: string, maxBytes: number): Promise<Uint8Array>;
  /** Write a shared code asset's module into a web game; answers its path. */
  vendorModule(gameDir: string, manifest: unknown): Promise<string | null>;
}

/**
 * The links file's text, or null. The game's folder is the game's (an agent or a cloned repo writes
 * it), so the file is read only from the game's own `.studio` folder, never through a link, never a
 * pipe or a device that would stall the read, and never past its cap.
 */
async function linksText(gameDir: string): Promise<string | null> {
  const dir = path.join(await realpath(gameDir), STUDIO_DIR);
  if ((await realpath(dir).catch(() => null)) !== dir) return null;
  const bytes = await readRegularFile(path.join(dir, ...LINKS_FILE), LINKS_MAX_BYTES).catch(() => null);
  return bytes ? bytes.toString("utf8") : null;
}

/** The game's links, empty when there are none or the file is unreadable. */
async function readLinks(gameDir: string): Promise<LinksFile> {
  const text = await linksText(gameDir).catch(() => null);
  const read: unknown = text === null ? null : parseJson(text);
  const listed = fieldOf(read, "files");
  // No prototype: a file named `__proto__` is a key like any other.
  const kept: Record<string, LibraryLink> = Object.create(null);
  for (const [file, link] of Object.entries(typeof listed === "object" && listed !== null ? listed : {})) {
    const generationId = fieldOf(link, "generationId");
    if (isGenerationId(generationId)) kept[file] = { generationId, sent: fieldOf(link, "sent") === true };
  }
  return { version: 1, files: kept };
}

/** A JSON text's value, or null when it does not parse. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Remember `files` as their generations, beside the links already there. */
async function writeLinks(gameDir: string, added: Record<string, LibraryLink>): Promise<void> {
  const links = await readLinks(gameDir);
  const dir = await ensureDirBelow(gameDir, [STUDIO_DIR]);
  await atomicWriteJson(path.join(dir, ...LINKS_FILE), { version: 1, files: { ...links.files, ...added } });
}

/** Runs one after another under a key: a run starts once the one before it under that key settled. */
type Turn = <T>(key: string, run: () => Promise<T>) => Promise<T>;

/** A fresh set of keyed turns. */
function keyedTurns(): Turn {
  const last = new Map<string, Promise<void>>();
  return <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const mine = (last.get(key) ?? Promise.resolve()).then(run);
    const settled = mine.then(
      () => undefined,
      () => undefined,
    );
    last.set(key, settled);
    void settled.then(() => {
      if (last.get(key) === settled) last.delete(key);
    });
    return mine;
  };
}

/** The turn key of a game's links file: two writes that overlap would each drop the other's link. */
const linksTurn = (gameDir: string): string => `links\n${gameDir}`;
/** The turn key of a game's Save: a second press waits, then finds the file the first one sent. */
const saveTurn = (project: string): string => `save\n${project}`;

/** The files the library can take: a model, picture, sound or video of the game's own. */
function libraryFiles(inventory: ProjectAssets): ProjectAsset[] {
  return inventory.assets.filter((asset) => libraryKindOf(asset) !== null);
}

/** Whether a file name's kind is one the library takes (a model, picture, sound or video). */
export const isLibraryFileName = (name: string): boolean => assetKind(name) !== "other";

/** The extension a downloaded file of each kind gets when its address names none. */
const KIND_EXTENSION = {
  [LibraryKind.Model]: "glb",
  [LibraryKind.Image]: "png",
  [LibraryKind.Sound]: "mp3",
  [LibraryKind.Video]: "mp4",
} as const satisfies Record<LibraryKind, string>;

/** A file name safe to write: the URL's last part when it is a library file, else `stem` with its kind's extension. */
function downloadName(url: string, stem: string, kind: LibraryKind): string {
  const last = decodedName(new URL(url).pathname.split("/").at(-1) ?? "");
  return SAFE_NAME.test(last) && isLibraryFileName(last) ? last : `${stem}.${KIND_EXTENSION[kind]}`;
}

/** An address's last part decoded, or empty when its escapes are broken. */
function decodedName(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return "";
  }
}

/** One library file of a game: the asset, the generation it is (or null), and whether Save sent it. */
interface KnownFile {
  asset: ProjectAsset;
  generationId: string | null;
  sent: boolean;
}

/** Each library file of the game with the generation it is (or null). */
async function knownFiles(deps: LibrarySharingDeps, project: string): Promise<KnownFile[]> {
  const dir = await deps.gameDir(project);
  const [inventory, links] = await Promise.all([deps.assets(project), readLinks(dir)]);
  return libraryFiles(inventory).map((asset) => {
    const link = links.files[asset.file];
    const generationId = asset.generationId ?? link?.generationId ?? null;
    return { asset, generationId, sent: !asset.generationId && link?.sent === true };
  });
}

/** The library's word on these generations, by id. */
async function lookup(deps: LibrarySharingDeps, ids: readonly string[]): Promise<Map<string, LibraryAsset>> {
  const found = new Map<string, LibraryAsset>();
  // With nothing to ask about, one read of an id no generation has still proves the account is
  // signed in and that genex.games filters by id (below): an older genex.games can't save files.
  const asked = ids.length > 0 ? ids : [PROBE_GENERATION_ID];
  for (let start = 0; start < asked.length; start += LIBRARY_IDS_MAX) {
    const run = asked.slice(start, start + LIBRARY_IDS_MAX);
    const page = await deps.library().list({ ids: run });
    // An older genex.games ignores `ids` and answers the newest rows: it has no Save or Share for the app.
    if (page.assets.some((asset) => !run.includes(asset.id))) throw new Error(MESSAGE.olderLibrary());
    for (const asset of page.assets) found.set(asset.id, asset);
  }
  return found;
}

/** Where each of the game's files stands with the library; every file only in the game when it can't be read. */
async function readStates(deps: LibrarySharingDeps, project: string): Promise<GameLibraryStates> {
  const files = await knownFiles(deps, project);
  const ids = [...new Set(files.map((file) => file.generationId).filter((id): id is string => id !== null))];
  const found = await lookup(deps, ids).catch(() => null);
  const states: AssetLibraryState[] = files.map(({ asset, generationId, sent }) => {
    const entry = generationId ? found?.get(generationId) : undefined;
    return {
      file: asset.file,
      generationId: entry ? entry.id : null,
      saved: entry?.saved ?? false,
      shared: entry?.shared ?? null,
      saveable: found !== null && (Boolean(entry) || (!generationId && isSendable(asset.file, asset.bytes))),
      shareable: Boolean(entry?.shareable) && !sent,
    };
  });
  return { project, states, unread: found === null };
}

/** Save files to the library (sending those Genex did not make), or take the Saved mark off. */
async function saveFiles(
  deps: LibrarySharingDeps,
  turn: Turn,
  project: string,
  files: readonly string[],
  saved: boolean,
): Promise<GameLibraryStates> {
  const dir = await deps.gameDir(project);
  const known = await knownFiles(deps, project);
  for (const file of files) {
    const match = known.find((entry) => entry.asset.file === file);
    if (!match) throw new Error(MESSAGE.notInGame());
    if (match.generationId) await deps.library().setSaved(match.generationId, saved);
    else if (saved) {
      const generationId = await sendFile(deps, dir, match.asset);
      // Each link as its file lands, so a later file's failure never leaves this one looking unsaved.
      await turn(linksTurn(dir), () => writeLinks(dir, { [file]: { generationId, sent: true } }));
    }
  }
  return readStates(deps, project);
}

/** A game file sent to the library, saved under what it was made from (else its name); its generation. */
async function sendFile(deps: LibrarySharingDeps, dir: string, asset: ProjectAsset): Promise<string> {
  // Checked before the file is read: genex.games would refuse it after the upload.
  if (!isSendable(asset.file, asset.bytes)) throw new Error(MESSAGE.notSendable());
  const read = await deps.readFile(dir, asset.file, sendMaxBytes(asset.file));
  const filename = asset.file.split("/").at(-1) ?? asset.file;
  const title = asset.prompt ?? filename;
  return deps.library().send({ filename, contentType: read.mimeType, bytes: read.data, title });
}

/** Share files to Play, each under its name; a file that can't be shared says why. */
async function shareFiles(
  deps: LibrarySharingDeps,
  project: string,
  items: readonly ShareItem[],
): Promise<ShareOutcome[]> {
  const current = await readStates(deps, project);
  const outcomes: ShareOutcome[] = [];
  for (const item of items) {
    const state = current.states.find((entry) => entry.file === item.file);
    if (!state) throw new Error(MESSAGE.notInGame());
    outcomes.push({ file: item.file, ...(await shareOne(deps, state, item.name)) });
  }
  return outcomes;
}

/** One file's share: refused when Genex did not make it, its page when it is on Play already. */
async function shareOne(deps: LibrarySharingDeps, state: AssetLibraryState, name: string): Promise<ShareAnswer> {
  if (!state.generationId || !state.shareable) return { miss: ShareMiss.NotShareable };
  if (state.shared?.live) return { shared: state.shared };
  // One share that can't reach genex.games misses alone: the ones before it are on Play already.
  return deps
    .library()
    .share(state.generationId, name)
    .catch((): ShareAnswer => ({ miss: ShareMiss.Failed }));
}

/** Take a file's shared page off Play. */
async function unshareFile(deps: LibrarySharingDeps, project: string, file: string): Promise<GameLibraryStates> {
  const state = (await readStates(deps, project)).states.find((entry) => entry.file === file);
  if (!state) throw new Error(MESSAGE.notInGame());
  if (state.shared?.live) await deps.library().unshare(state.shared.projectId);
  return readStates(deps, project);
}

/** Write `bytes` into a fresh folder under `assets/<folder>/`; answers the game-relative path. */
async function place(dir: string, folder: string, name: string, bytes: Uint8Array): Promise<string> {
  const job = randomUUID();
  const target = await ensureDirBelow(dir, ["assets", folder, job]);
  await createFileInDir(target, name, bytes);
  return ["assets", folder, job, name].join("/");
}

/** A library generation's file, copied into the game and linked to its generation. */
async function addGeneration(
  deps: LibrarySharingDeps,
  turn: Turn,
  project: string,
  generationId: string,
): Promise<AddOutcome> {
  const dir = await deps.gameDir(project);
  const entry = (await lookup(deps, [generationId])).get(generationId);
  if (!entry) throw new NotInLibrary();
  if (!entry.fileUrl) throw new Error(MESSAGE.noFile());
  const bytes = await deps.download(entry.fileUrl, LIBRARY_FILE_MAX_BYTES);
  const file = await place(dir, AddFolder.Library, downloadName(entry.fileUrl, entry.id, entry.kind), bytes);
  await turn(linksTurn(dir), () => writeLinks(dir, { [file]: { generationId, sent: false } }));
  return { files: [file] };
}

/** A shared asset: its file when it has one (Genex made it), else its code module (web games). */
async function addShared(deps: LibrarySharingDeps, project: string, slug: string): Promise<AddOutcome> {
  const dir = await deps.gameDir(project);
  const manifest = await deps.manifest(slug);
  const asset = fieldOf(fieldOf(manifest, "manifest"), "asset");
  const fileUrl = libraryFileUrl(fieldOf(asset, "fileUrl"));
  if (fileUrl) {
    const bytes = await deps.download(fileUrl, LIBRARY_FILE_MAX_BYTES);
    const name = downloadName(fileUrl, slug, MEDIA_KIND[String(fieldOf(asset, "media"))] ?? LibraryKind.Model);
    return { files: [await place(dir, AddFolder.Community, name, bytes)] };
  }
  if (!(await deps.webGame(project))) throw new Error(MESSAGE.notWebGame());
  const written = await deps.vendorModule(dir, manifest);
  if (!written) throw new Error(MESSAGE.noFile());
  return { files: [written] };
}

/** Bring a library generation or a shared asset into the game. */
function addToGame(deps: LibrarySharingDeps, turn: Turn, project: string, source: AddSource): Promise<AddOutcome> {
  if ("generationId" in source && isGenerationId(source.generationId)) {
    return addGeneration(deps, turn, project, source.generationId);
  }
  if ("slug" in source && isPlaySlug(source.slug)) return addShared(deps, project, source.slug);
  return Promise.reject(new Error(MESSAGE.notFound()));
}

/** A game's library sharing over `deps`. */
export function librarySharing(deps: LibrarySharingDeps) {
  const turn = keyedTurns();
  return {
    states: (project: string) => readStates(deps, project),
    save: (project: string, files: readonly string[], saved: boolean) =>
      turn(saveTurn(project), () => saveFiles(deps, turn, project, files, saved)),
    share: (project: string, items: readonly ShareItem[]) => shareFiles(deps, project, items),
    unshare: (project: string, file: string) => unshareFile(deps, project, file),
    add: (project: string, source: AddSource) => addToGame(deps, turn, project, source),
  };
}

function fieldOf(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

/** The game's library sharing as `librarySharing` makes it. */
export type LibrarySharing = ReturnType<typeof librarySharing>;
