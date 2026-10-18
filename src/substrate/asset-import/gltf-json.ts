/**
 * Reading a glTF document's JSON without trusting it: the typed views the import steps share
 * (`gltf-decompress.ts`, `dequantize.ts`). Every reader answers a safe default for a value of the
 * wrong shape; the steps decide whether that refuses the file.
 */
import { AssetImportRefusal } from "./import-plan.ts";

/** A JSON object of a glTF document. */
export type Json = Record<string, unknown>;

/** Why a glTF was refused, with the import step's code. */
export class GltfImportError extends Error {
  readonly code: AssetImportRefusal;
  constructor(code: AssetImportRefusal, message: string) {
    super(message);
    this.name = "GltfImportError";
    this.code = code;
  }
}

/** A refusal for a damaged file. */
export const malformed = (message: string) => new GltfImportError(AssetImportRefusal.Malformed, message);

/** Whether `value` is a JSON object (not an array, not null). */
export const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** The objects of an array; anything else is empty. */
export const objects = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isObject) : []);
/** The strings of an array; anything else is empty. */
export const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
/** A non-negative safe integer, or null. */
export const index = (value: unknown): number | null =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;

/** The extension object `name` on `owner`, or null. */
export function extension(owner: Json, name: string): Json | null {
  const extensions = owner.extensions;
  if (!isObject(extensions)) return null;
  const found = extensions[name];
  return isObject(found) ? found : null;
}

/** Remove the extension `name` from `owner`, and its `extensions` object when that empties it. */
export function dropExtension(owner: Json, name: string): void {
  const extensions = owner.extensions;
  if (!isObject(extensions)) return;
  delete extensions[name];
  if (!Object.keys(extensions).length) delete owner.extensions;
}

/** Point every `bufferView` reference (accessors, sparse parts, images) at its new index. */
export function remapViews(json: Json, moved: ReadonlyMap<number, number>): void {
  const remap = (owner: Json | undefined) => {
    const at = owner ? index(owner.bufferView) : null;
    if (owner && at !== null && moved.has(at)) owner.bufferView = moved.get(at);
  };
  for (const accessor of objects(json.accessors)) {
    remap(accessor);
    const sparse = isObject(accessor.sparse) ? accessor.sparse : undefined;
    remap(isObject(sparse?.indices) ? sparse.indices : undefined);
    remap(isObject(sparse?.values) ? sparse.values : undefined);
  }
  for (const image of objects(json.images)) remap(image);
}

/** `json.extensionsUsed` and `json.extensionsRequired` without the names `gone` says. */
export function withoutExtensions(json: Json, gone: (name: string) => boolean): Json {
  const keep = (names: unknown) => strings(names).filter((name) => !gone(name));
  const used = keep(json.extensionsUsed);
  const required = keep(json.extensionsRequired);
  const rest: Json = { ...json };
  delete rest.extensionsUsed;
  delete rest.extensionsRequired;
  return {
    ...rest,
    ...(used.length ? { extensionsUsed: used } : {}),
    ...(required.length ? { extensionsRequired: required } : {}),
  };
}
