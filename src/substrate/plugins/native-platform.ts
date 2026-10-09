import path from "node:path";
import { readdir } from "node:fs/promises";
import { assertRelativePath } from "../paths.ts";

const CANDIDATE_ALIAS = /^(home|studio|storage|program-files):(.+)$/;
const MAX_VERSION_FOLDERS = 256;
const MESSAGE = {
  CandidatePath: "Runtime candidates must use absolute, home:, studio:, storage: or program-files: paths",
  CandidateGlob: "Runtime candidate paths allow one wildcard in a named directory, followed by an executable",
  TooManyFolders: "Runtime candidate directory has too many entries",
} as const;

/** Validate a reviewed candidate on every host, including Windows drive paths and one directory wildcard. */
export function validateRuntimeCandidate(candidate: string): void {
  const alias = CANDIDATE_ALIAS.exec(candidate);
  const absolute = candidate.startsWith("/") || /^[a-z]:[\\/]/i.test(candidate);
  if (!alias && !absolute) throw new Error(MESSAGE.CandidatePath);
  const relative = alias ? alias[2] : candidate.replace(/^(?:[a-z]:[\\/]|\/)/i, "").replaceAll("\\", "/");
  assertRelativePath(relative);
  if (relative.includes(":") || relative.split("/").some((segment) => /[. ]$/.test(segment)))
    throw new Error(MESSAGE.CandidatePath);
  const segments = relative.split("/");
  const wildcards = segments.filter((segment) => segment.includes("*"));
  if (!wildcards.length) return;
  const wildcard = wildcards[0];
  const valid = alias && wildcards.length === 1 && wildcard !== "*" && wildcard.split("*").length === 2;
  if (!valid || segments.at(-1)?.includes("*")) throw new Error(MESSAGE.CandidateGlob);
}

/** Host-owned roots a reviewed runtime's candidate aliases may resolve against. */
export interface RuntimeCandidateRoots {
  home: string;
  studio: string;
  storage: string;
  programFiles?: string;
}

/** Expand only the candidate paths declared by the plugin. */
export async function runtimeCandidates(candidates: string[], roots: RuntimeCandidateRoots): Promise<string[]> {
  const result: string[] = [];
  for (const candidate of candidates) {
    validateRuntimeCandidate(candidate);
    const alias = CANDIDATE_ALIAS.exec(candidate);
    if (!alias) {
      result.push(candidate);
      continue;
    }
    const aliasName = alias[1] === "program-files" ? "programFiles" : alias[1];
    const root = roots[aliasName as keyof RuntimeCandidateRoots];
    if (!root) continue;
    const segments = alias[2].split("/");
    const wildcardIndex = segments.findIndex((segment) => segment.includes("*"));
    if (wildcardIndex < 0) result.push(path.join(root, ...segments));
    else result.push(...(await expandVersionFolders(root, segments, wildcardIndex)));
  }
  return result;
}

/** Expand a single declared directory wildcard, never following a matching directory link. */
async function expandVersionFolders(root: string, segments: string[], index: number): Promise<string[]> {
  const directory = path.join(root, ...segments.slice(0, index));
  const folders = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  if (folders.length > MAX_VERSION_FOLDERS) throw new Error(MESSAGE.TooManyFolders);
  const [prefix, suffix] = segments[index].split("*");
  return folders
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix) && entry.name.endsWith(suffix))
    .sort((a, b) => b.name.localeCompare(a.name, "en", { numeric: true }))
    .map((entry) => path.join(directory, entry.name, ...segments.slice(index + 1)));
}
