import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { SECOND_MS } from "../shared/duration.ts";
import { HOST_GIT_CONFIG } from "./snapshots.ts";
import { isBelow } from "./paths.ts";
import type { ContentStamps } from "../shared/game-project.ts";

/** How long a whole stamp may take; past it the stamp is unknown. */
const STAMP_DEADLINE_MS = 5 * SECOND_MS;
/** The file listing's own limits. */
const LIST_TIMEOUT_MS = 5 * SECOND_MS;
const LIST_MAX_BUFFER_BYTES = 4 * 1024 ** 2;
/** Past these a folder is not stamped at all. */
const MAX_STAMPED_FILES = 20_000;
const MAX_STAMPED_BYTES = 256 * 1024 ** 2;

/**
 * .gitignore is not a public-file policy: generated assets/build output may be ignored
 * by Git while still serving in Live. Only omit known tooling directories here.
 */
const TOOLING_DIRS = [".git", ".studio", ".genex", ".claude", ".codex", ".cache", "node_modules"];
/** Path segments that are tooling or the builders' own pages, never game content. */
const NOT_CONTENT = [...TOOLING_DIRS, "AGENTS.md", "CLAUDE.md", "NOTES.md"];
/** Plans and notes: a turn that wrote only these changed nothing the preview can show. */
const DOCS_DIR = "docs/";
const MARKDOWN_EXT = ".md";
/** Stamps nobody could take. */
const UNKNOWN_STAMPS: ContentStamps = Object.freeze({ all: null, source: null });

/** A document, not game source: anything under docs/, and Markdown anywhere. */
function isDocument(file: string): boolean {
  return file.startsWith(DOCS_DIR) || file.toLowerCase().endsWith(MARKDOWN_EXT);
}

/** The files git lists in the folder (tracked and untracked), tooling and notes left out, sorted. */
async function contentFiles(root: string): Promise<string[]> {
  const { stdout } = await promisify(execFile)(
    "git",
    [
      ...HOST_GIT_CONFIG,
      "-C",
      root,
      "ls-files",
      "--cached",
      "--others",
      ...TOOLING_DIRS.map((name) => `--exclude=**/${name}/`),
      "-z",
    ],
    { timeout: LIST_TIMEOUT_MS, maxBuffer: LIST_MAX_BUFFER_BYTES, windowsHide: true },
  );
  return [...new Set(stdout.split("\0").filter(Boolean))]
    .filter((file) => !file.split("/").some((part) => NOT_CONTENT.includes(part)))
    .sort();
}

/** The file's bytes as one digest, or null when the deadline passes while reading. */
async function contentDigest(file: string, deadline: number): Promise<Buffer | null> {
  const content = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    if (Date.now() > deadline) return null;
    content.update(chunk);
  }
  return content.digest();
}

/**
 * Fold one listed file into the stamps it counts for: its name and mode, then its bytes. False
 * when the file makes the stamps unknowable — out of time, a path that leaves the folder, a link,
 * anything but a regular file, or past the byte budget.
 */
async function addToStamp(
  hashes: readonly Hash[],
  root: string,
  file: string,
  budget: { deadline: number; bytes: number },
): Promise<boolean> {
  const leavesFolder = path.isAbsolute(file) || file.split("/").includes("..");
  if (Date.now() > budget.deadline || leavesFolder) return false;
  const absolute = path.join(root, file);
  const info = await lstat(absolute).catch((e) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  const entry = JSON.stringify([file, info?.mode ?? "missing"]);
  for (const hash of hashes) hash.update(entry);
  if (!info) return true;
  if (info.isSymbolicLink()) return false;
  if (!info.isFile()) return false;
  const resolved = await realpath(absolute);
  if (!isBelow(root, resolved)) return false;
  budget.bytes += info.size;
  if (budget.bytes > MAX_STAMPED_BYTES) return false;
  const content = await contentDigest(resolved, budget.deadline);
  if (content === null) return false;
  for (const hash of hashes) hash.update(content);
  return true;
}

/** Bounded, read-only content comparison for chat follow-ups. No commits or new ledger.
 * Unknown means the usual preview check still runs; a matching stamp proves no included
 * game source/asset bytes changed. Ignore only tooling/private files, never game assets. */
export async function workspaceContentStamp(directory: string): Promise<string | null> {
  return (await workspaceContentStamps(directory)).all;
}

/**
 * Both stamps from one walk of the folder: everything, and the game's sources without docs/ and
 * Markdown — a turn that only wrote a plan or research notes changed nothing the preview shows.
 * A folder with no source at all has no source stamp (unknown).
 */
export async function workspaceContentStamps(directory: string): Promise<ContentStamps> {
  try {
    const root = await realpath(directory);
    const budget = { deadline: Date.now() + STAMP_DEADLINE_MS, bytes: 0 };
    const files = await contentFiles(root);
    if (!files.length || files.length > MAX_STAMPED_FILES) return UNKNOWN_STAMPS;
    const all = createHash("sha256");
    const source = createHash("sha256");
    let sources = 0;
    for (const file of files) {
      const document = isDocument(file);
      if (!document) sources++;
      if (!(await addToStamp(document ? [all] : [all, source], root, file, budget))) return UNKNOWN_STAMPS;
    }
    return { all: all.digest("hex"), source: sources ? source.digest("hex") : null };
  } catch {
    return UNKNOWN_STAMPS;
  }
}
