/**
 * Where the saved local server lives: its base URL and the software it was found to be, in a small
 * JSON file in the engine's home. The address is not a secret; its API key is kept apart, in the OS
 * secret store (`provider-keys.ts`). A file that does not read back as a local server's address is
 * treated as no server at all, never repaired into one.
 */
import { rm } from "node:fs/promises";
import { atomicWriteJson, isJsonObject, readJsonIfExists } from "../fsx.ts";
import { LocalServerKind } from "../../shared/local-server.ts";
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
