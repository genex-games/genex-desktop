/**
 * The pictures home's background can show: the bundled ones, and those the user added, kept in
 * IndexedDB at a size the effects never outgrow. A picture is decoded once and kept while shown.
 */
import { HOME_BACKDROP_IMAGES_DB } from "../storage.ts";

const STORE = "images";
/** Pictures a user can add. */
export const MAX_BACKDROP_UPLOADS = 8;
/** A picture larger than this is refused before it is decoded. */
export const BACKDROP_UPLOAD_MAX_BYTES = 40 * 1024 * 1024;
/** An added picture is kept at most this long on its longer side: more than any effect samples. */
const UPLOAD_LONG_SIDE = 1600;
const UPLOAD_QUALITY = 0.9;
/** Decoded pictures kept: the one shown, and the last one before it. */
const DECODED_KEPT = 2;
const UPLOAD_PREFIX = "upload:";

/** A picture to choose: its id in the settings, a name for it, and where its thumbnail comes from. */
export interface BackdropPicture {
  id: string;
  label: string;
  url: string;
  added: boolean;
}

/** The pictures every profile has, copied beside the renderer by the build. */
export const BUNDLED_BACKDROPS: readonly BackdropPicture[] = [
  { id: "builtin:realm", label: "Realm", url: "media/home-backdrop-realm.jpg", added: false },
  { id: "builtin:city", label: "City", url: "media/home-backdrop-city.jpg", added: false },
  { id: "builtin:clouds", label: "Clouds", url: "media/home-backdrop-clouds.jpg", added: false },
  { id: "builtin:campfire", label: "Campfire", url: "media/home-backdrop-campfire.jpg", added: false },
];

type UploadRecord = { id: string; blob: Blob; at: number };

/** Why a picture could not be added. */
export const UploadProblem = {
  TooLarge: "too-large",
  Unreadable: "unreadable",
  Full: "full",
  Unsaved: "unsaved",
} as const;
export type UploadProblem = (typeof UploadProblem)[keyof typeof UploadProblem];

let database: Promise<IDBDatabase | null> | null = null;
function open(): Promise<IDBDatabase | null> {
  database ??= new Promise((resolve) => {
    try {
      const request = indexedDB.open(HOME_BACKDROP_IMAGES_DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return database;
}

/** The result of one request, or `fallback` when the store cannot answer. */
async function ask<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest, fallback: T): Promise<T> {
  const db = await open();
  if (!db) return fallback;
  return new Promise((resolve) => {
    try {
      const request = run(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve((request.result as T | undefined) ?? fallback);
      request.onerror = () => resolve(fallback);
    } catch {
      resolve(fallback);
    }
  });
}

const listeners = new Set<() => void>();
/** Hear the added pictures change; returns the unsubscribe. */
export function subscribeBackdropUploads(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function changed(): void {
  for (const listener of listeners) listener();
}

/** The pictures the user added, oldest first. */
export async function listBackdropUploads(): Promise<{ id: string; blob: Blob }[]> {
  const records = await ask<UploadRecord[]>("readonly", (store) => store.getAll(), []);
  return records.sort((a, b) => a.at - b.at).map(({ id, blob }) => ({ id, blob }));
}

/** `file` shrunk to the kept size, as WebP. */
async function shrink(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const fit = Math.min(1, UPLOAD_LONG_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * fit), Math.round(bitmap.height * fit));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("No 2D context");
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.convertToBlob({ type: "image/webp", quality: UPLOAD_QUALITY });
}

/** Keep a picture the user chose; its id, or why it was not kept. */
export async function addBackdropUpload(file: Blob): Promise<{ id: string } | { problem: UploadProblem }> {
  if (file.size > BACKDROP_UPLOAD_MAX_BYTES) return { problem: UploadProblem.TooLarge };
  if ((await listBackdropUploads()).length >= MAX_BACKDROP_UPLOADS) return { problem: UploadProblem.Full };
  let blob: Blob;
  try {
    blob = await shrink(file);
  } catch {
    return { problem: UploadProblem.Unreadable };
  }
  const id = `${UPLOAD_PREFIX}${crypto.randomUUID()}`;
  const saved = await ask<unknown>("readwrite", (store) => store.put({ id, blob, at: Date.now() }), null);
  if (saved === null) return { problem: UploadProblem.Unsaved };
  changed();
  return { id };
}

/** Forget an added picture. */
export async function removeBackdropUpload(id: string): Promise<void> {
  await ask("readwrite", (store) => store.delete(id), null);
  decoded.delete(id);
  changed();
}

/** A bundled picture, decoded from its file. */
async function bundled(url: string): Promise<ImageBitmap> {
  const image = new Image();
  image.src = url;
  await image.decode();
  return createImageBitmap(image);
}

const decoded = new Map<string, Promise<ImageBitmap | null>>();
/** The picture `id` names, decoded; null when it is gone or unreadable. */
export function loadBackdropPicture(id: string): Promise<ImageBitmap | null> {
  const known = decoded.get(id);
  if (known) return known;
  const picture = BUNDLED_BACKDROPS.find((candidate) => candidate.id === id);
  const loading = (
    picture
      ? bundled(picture.url)
      : ask<UploadRecord | null>("readonly", (store) => store.get(id), null).then((record) =>
          record ? createImageBitmap(record.blob) : null,
        )
  ).catch(() => null);
  decoded.set(id, loading);
  // Keep the newest few: a picture swapped out is let go.
  for (const old of [...decoded.keys()].slice(0, Math.max(0, decoded.size - DECODED_KEPT))) decoded.delete(old);
  return loading;
}
