/**
 * The folders Windows keeps where the person put them, read from the registry rather than guessed:
 * where Steam is installed (`SteamPath`, which may be on any drive) and where Documents is (often
 * moved into OneDrive). Read with Windows's own `reg.exe` by its whole path, no shell; nothing is
 * read anywhere but on Windows.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { SECOND_MS } from "../../shared/duration.ts";

/** Reads one registry value as text, or null when it isn't there. */
export type RegistryRead = (key: string, value: string) => Promise<string | null>;

/** Where Steam records its own folder. */
export const STEAM_KEY = { key: "HKCU\\Software\\Valve\\Steam", value: "SteamPath" } as const;
/** Where Windows records the real Documents folder, already expanded. */
export const DOCUMENTS_KEY = {
  key: "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders",
  value: "Personal",
} as const;

/** How long one registry read may take. */
const REG_TIMEOUT_MS = 5 * SECOND_MS;
/** Windows's own folder when the environment names none. */
const WINDOWS_ROOT = "C:\\Windows";
/** One value line of `reg query`'s answer: its name, its type, its data. */
const VALUE_LINE = /^\s+(\S.*?)\s+(REG_SZ|REG_EXPAND_SZ)\s+(.*)$/;

/** A value's data from `reg query`'s answer, or null when the answer names no such value. */
export function regValue(output: string, value: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const match = VALUE_LINE.exec(line);
    if (match && match[1]?.toLowerCase() === value.toLowerCase()) return match[3]?.trim() || null;
  }
  return null;
}

/** A Windows path as Steam writes it (`c:/program files (x86)/steam`) in Windows's own spelling; null for anything else. */
export function windowsPath(value: string | null): string | null {
  if (!value) return null;
  const normal = path.win32.normalize(value.replaceAll("/", "\\"));
  return path.win32.isAbsolute(normal) && /^[A-Za-z]:\\/.test(normal) ? normal : null;
}

const run = promisify(execFile);

/** This computer's registry, through `reg.exe` by its whole path. */
export function systemRegistry(env: NodeJS.ProcessEnv = process.env): RegistryRead {
  const root = env.SystemRoot && path.win32.isAbsolute(env.SystemRoot) ? env.SystemRoot : WINDOWS_ROOT;
  const reg = path.win32.join(root, "System32", "reg.exe");
  return async (key, value) => {
    const answer = await run(reg, ["query", key, "/v", value], { timeout: REG_TIMEOUT_MS, windowsHide: true }).catch(
      () => null,
    );
    return answer ? regValue(answer.stdout, value) : null;
  };
}
