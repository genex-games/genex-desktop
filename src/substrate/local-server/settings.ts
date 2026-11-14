/**
 * Where the saved local server lives: its base URL and the software it was found to be, in a small
 * JSON file in the engine's home. The address is not a secret; its API key is kept apart, in the OS
 * secret store (`provider-keys.ts`). A file that does not read back as a local server's address is
 * treated as no server at all, never repaired into one.
 */
import { rm } from "node:fs/promises";
import { atomicWriteJson, isJsonObject, readJsonIfExists } from "../fsx.ts";
import {
  LocalServerKind,
  MAX_OVERRIDE_CONTEXT,
  MIN_OVERRIDE_CONTEXT,
  type ModelOverride,
} from "../../shared/local-server.ts";
import { readServerAddress } from "./address.ts";

/** The saved server: the API's base URL and, when known, which software answers there. */
export interface SavedServer {
  url: string;
  kind: LocalServerKind | null;
}

/** Read, replace or forget the saved server. */
export interface ServerSettings {
  read(): Promise<SavedServer | null>;
  write(saved: SavedServer): Promise<void>;
  clear(): Promise<void>;
}

const KINDS: ReadonlySet<string> = new Set(Object.values(LocalServerKind));

/** The saved server a file holds, or null for one that is missing, unreadable or not an address. */
function savedServer(value: unknown): SavedServer | null {
  if (!isJsonObject(value) || typeof value.url !== "string") return null;
  const read = readServerAddress(value.url);
  if (!read.ok || read.baseUrl !== value.url) return null;
  const kind = typeof value.kind === "string" && KINDS.has(value.kind) ? (value.kind as LocalServerKind) : null;
  return { url: read.baseUrl, kind };
}

/** The saved server in the JSON file at `file`. */
export function serverSettings(file: string): ServerSettings {
  return {
    read: async () => savedServer(await readJsonIfExists<unknown>(file).catch(() => null)),
    write: (saved) => atomicWriteJson(file, { url: saved.url, kind: saved.kind }),
    clear: () => rm(file, { force: true }),
  };
}

/** A saved server held in memory: for tests and fixture profiles, which write no file. */
export function memoryServerSettings(initial: SavedServer | null = null): ServerSettings {
  let value = initial;
  return {
    read: async () => value,
    write: async (saved) => {
      value = { ...saved };
    },
    clear: async () => {
      value = null;
    },
  };
}

/** Persists per-model overrides (context window, vision, tools) for a local server. */
export interface ModelOverridesStore {
  readonly file: string;
  read(): Promise<Record<string, ModelOverride>>;
  write(id: string, override: ModelOverride | null): Promise<void>;
}

/** Sanitize a model override: finite numbers in sane range, boolean capabilities. */
export function sanitizeModelOverride(raw: unknown): ModelOverride | null {
  if (!isJsonObject(raw)) return null;
  const clean: ModelOverride = {};
  if (typeof raw.contextWindow === "number" && Number.isFinite(raw.contextWindow)) {
    const tokens = Math.floor(raw.contextWindow);
    if (tokens >= MIN_OVERRIDE_CONTEXT && tokens <= MAX_OVERRIDE_CONTEXT) {
      clean.contextWindow = tokens;
    }
  }
  if (typeof raw.supportsVision === "boolean") {
    clean.supportsVision = raw.supportsVision;
  }
  if (typeof raw.supportsTools === "boolean") {
    clean.supportsTools = raw.supportsTools;
  }
  return Object.keys(clean).length > 0 ? clean : null;
}

function sanitizeOverridesRecord(data: unknown): Record<string, ModelOverride> {
  if (!isJsonObject(data)) return {};
  const clean: Record<string, ModelOverride> = {};
  for (const [id, value] of Object.entries(data)) {
    const validated = sanitizeModelOverride(value);
    if (validated) clean[id] = validated;
  }
  return clean;
}

/** File-backed JSON store for per-model overrides. */
export function modelOverridesStore(file: string): ModelOverridesStore {
  return {
    file,
    read: async () => sanitizeOverridesRecord(await readJsonIfExists<unknown>(file).catch(() => null)),
    write: async (id: string, override: ModelOverride | null) => {
      const current = sanitizeOverridesRecord(await readJsonIfExists<unknown>(file).catch(() => null));
      const validated = override ? sanitizeModelOverride(override) : null;
      if (validated) current[id] = validated;
      else delete current[id];
      await atomicWriteJson(file, current);
    },
  };
}

/** In-memory store for per-model overrides, for tests. */
export function memoryModelOverridesStore(): ModelOverridesStore {
  const value: Record<string, ModelOverride> = {};
  return {
    file: ":memory:",
    read: async () => ({ ...value }),
    write: async (id, override) => {
      const validated = override ? sanitizeModelOverride(override) : null;
      if (validated) value[id] = validated;
      else delete value[id];
    },
  };
}
