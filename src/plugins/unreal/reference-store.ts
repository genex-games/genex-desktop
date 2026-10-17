/**
 * The node reference (`ReferenceData`) and the engine's Python names, kept per engine in the Unreal
 * plugin's storage (`reference/<engine>/`). The Genex editor helper exports them in seconds while
 * the editor is open (`export_reference`, `export_python_names`); the builders' gate reads them
 * without it. Pins read later for the nodes builders use are merged in. A file that isn't the
 * reference's shape is never believed.
 */
import path from "node:path";
import { atomicWriteJson, isJsonObject, readRegularFile } from "../../substrate/fsx.ts";
import type { NodePins, ReferenceData } from "./blueprint-reference.ts";

/** An engine version as the folder is named: "5.8" or "5.8.3". */
const ENGINE_VERSION = /^\d+\.\d+(\.\d+)?$/;
/** The largest reference file read back (the full 5.8 names are about 3 MB). */
const MAX_REFERENCE_BYTES = 32 * 1024 * 1024;
const FOLDER = "reference";

const MESSAGE = { BadEngine: (engine: string) => `${JSON.stringify(engine)} is not an engine version.` } as const;

/** Where one engine's reference files live in the plugin's storage. */
export function referencePaths(storage: string, engine: string): { nodes: string; python: string } {
  if (!ENGINE_VERSION.test(engine)) throw new Error(MESSAGE.BadEngine(engine));
  const dir = path.join(storage, FOLDER, engine);
  return { nodes: path.join(dir, "nodes.json"), python: path.join(dir, "python-names.json") };
}

const isNames = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((name) => typeof name === "string");

/** A parsed value as a reference, or null when it hasn't the reference's shape. */
export const parseReference = (value: unknown): ReferenceData | null => (isReference(value) ? value : null);

/** Whether a parsed file has the reference's shape. */
function isReference(value: unknown): value is ReferenceData {
  if (!isJsonObject(value) || value.version !== 1 || typeof value.engine !== "string") return false;
  if (!isNames(value.common) || !isJsonObject(value.contexts) || !isJsonObject(value.pins)) return false;
  return Object.values(value.contexts).every(isNames);
}

/** One engine's node reference, or null while it hasn't been exported (or the file is not one). */
export async function loadReference(storage: string, engine: string): Promise<ReferenceData | null> {
  const { nodes } = referencePaths(storage, engine);
  try {
    const parsed: unknown = JSON.parse((await readRegularFile(nodes, MAX_REFERENCE_BYTES)).toString("utf8"));
    return isReference(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Keeps a freshly exported reference, with any pins already read for this engine. */
export async function storeReference(storage: string, engine: string, data: ReferenceData): Promise<void> {
  const known = await loadReference(storage, engine);
  await atomicWriteJson(referencePaths(storage, engine).nodes, { ...data, pins: { ...known?.pins, ...data.pins } });
}

/** Adds pins read later to an engine's reference; nothing happens before the reference exists. */
export async function mergePins(storage: string, engine: string, pins: Record<string, NodePins>): Promise<void> {
  const known = await loadReference(storage, engine);
  if (!known) return;
  await atomicWriteJson(referencePaths(storage, engine).nodes, { ...known, pins: { ...known.pins, ...pins } });
}
