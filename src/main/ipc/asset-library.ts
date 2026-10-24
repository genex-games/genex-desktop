/** The asset library: the account's genex.games library, and Save, Share and Add for a game's assets. */
import {
  type AddSource,
  isGenerationId,
  isLibraryKind,
  LIBRARY_BATCH_MAX,
  LIBRARY_IDS_MAX,
  type LibraryQuery,
  SHARE_NAME_MAX,
  type ShareItem,
} from "../../shared/asset-library.ts";
import { isPlaySlug } from "../../shared/play.ts";
import type { LibrarySharing } from "../core/library-sharing.ts";
import type { AssetLibrary, LibraryPictureFile } from "../play/asset-library.ts";
import type { IpcHandle } from "./registrar.ts";

const MESSAGE = {
  projectRequired: "project is required",
  fileRequired: "a game file is required",
  badSource: "not a library asset or a shared asset",
  badName: "a name for Play is required",
  tooMany: `at most ${LIBRARY_BATCH_MAX} files at once`,
} as const;

const FILE_MAX = 1024;

/** What the asset library's channels answer from. */
export interface AssetLibraryIpcDeps {
  library: AssetLibrary;
  sharing: LibrarySharing;
  /** A tile's picture file, which checks the address itself before anything is asked. */
  pictureFile: LibraryPictureFile;
}

/** A library read as the renderer may ask it: only the fields it knows, in their shapes. */
function readQuery(payload: unknown): LibraryQuery {
  const raw = (typeof payload === "object" && payload !== null ? payload : {}) as Record<string, unknown>;
  return {
    ...(typeof raw.query === "string" ? { query: raw.query } : {}),
    ...(isLibraryKind(raw.kind) ? { kind: raw.kind } : {}),
    ...(raw.saved === true ? { saved: true } : {}),
    ...(Array.isArray(raw.ids) ? { ids: raw.ids.filter(isGenerationId).slice(0, LIBRARY_IDS_MAX) } : {}),
    ...(isGenerationId(raw.before) ? { before: raw.before } : {}),
  };
}

function readProject(payload: { project?: unknown } | undefined): string {
  if (typeof payload?.project !== "string" || !payload.project) throw new Error(MESSAGE.projectRequired);
  return payload.project;
}

function readFile(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > FILE_MAX) throw new Error(MESSAGE.fileRequired);
  return value;
}

function readFiles(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(MESSAGE.fileRequired);
  // Never cut a batch short without saying so: the renderer sends runs of at most this many.
  if (value.length > LIBRARY_BATCH_MAX) throw new Error(MESSAGE.tooMany);
  return value.map(readFile);
}

function readShareItems(value: unknown): ShareItem[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(MESSAGE.fileRequired);
  if (value.length > LIBRARY_BATCH_MAX) throw new Error(MESSAGE.tooMany);
  return value.map((item) => {
    const raw = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    const name = typeof raw.name === "string" ? raw.name.trim().slice(0, SHARE_NAME_MAX) : "";
    if (!name) throw new Error(MESSAGE.badName);
    return { file: readFile(raw.file), name };
  });
}

function readSource(value: unknown): AddSource {
  const raw = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  if (isGenerationId(raw.generationId)) return { generationId: raw.generationId };
  if (isPlaySlug(raw.slug)) return { slug: raw.slug };
  throw new Error(MESSAGE.badSource);
}

/** Register the asset library's channels. */
export function registerAssetLibraryIpc(handle: IpcHandle, deps: AssetLibraryIpcDeps): void {
  const { library, sharing, pictureFile } = deps;
  handle("studio:assets.library", (payload) => library.list(readQuery(payload)));
  handle("studio:assets.states", (payload) => sharing.states(readProject(payload)));
  handle("studio:assets.save", (payload) =>
    sharing.save(readProject(payload), readFiles(payload?.files), payload?.saved !== false),
  );
  handle("studio:assets.share", (payload) => sharing.share(readProject(payload), readShareItems(payload?.items)));
  handle("studio:assets.unshare", (payload) => sharing.unshare(readProject(payload), readFile(payload?.file)));
  handle("studio:assets.add", (payload) => sharing.add(readProject(payload), readSource(payload?.source)));
  handle("studio:assets.file", (payload) => pictureFile(payload?.url));
}
