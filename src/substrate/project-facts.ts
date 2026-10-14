/**
 * The facts a project folder holds on disk (`shared/project-facts.ts`): a bounded walk of its files
 * matched against the core table and the rules enabled plugins add. The folder is the agent's and
 * the person's, so the walk only reads: it never follows a link, stays a few folders deep and stops
 * after a fixed number of entries.
 */
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  CORE_FACT_RULES,
  CoreFact,
  FactSource,
  factsOfFiles,
  hasFact,
  NOT_WALKED,
  type ProjectFact,
  type SourcedFactRule,
  settleFacts,
} from "../shared/project-facts.ts";
import { isCompiledStack, isGameStack } from "../shared/game-project.ts";
import { readOwnJsonForUpdate } from "./fsx.ts";

/** The most of a game's studio.json the studio reads; a bigger one reads as absent (and is never rewritten). */
export const STUDIO_JSON_MAX_BYTES = 1024 * 1024;

/** How deep and how wide one walk goes: deep enough for `a/ProjectSettings/…`, never a whole disk. */
const WALK = { MaxDepth: 4, MaxEntries: 4000 } as const;

/** The core table with its source, first in every detection so a core fact wins a tie. */
const CORE_RULES: readonly SourcedFactRule[] = CORE_FACT_RULES.map((rule) => ({ rule, source: FactSource.Core }));

/** How far a walk may go. */
export interface WalkLimits {
  maxDepth?: number;
  maxEntries?: number;
}

/** A folder still to read, by its POSIX path relative to the walk's root ("" for the root). */
interface Pending {
  rel: string;
  depth: number;
}

const joinRel = (rel: string, name: string) => (rel ? `${rel}/${name}` : name);

/** Whether the walk enters a folder entry: a real folder (never a link), not hidden, not skipped. */
const entersFolder = (entry: Dirent) =>
  entry.isDirectory() && !entry.name.startsWith(".") && !NOT_WALKED.has(entry.name);

/** One walk in progress: the files found, the folders still to read, and how many entries it has seen. */
interface Walk {
  files: string[];
  queue: Pending[];
  seen: number;
  maxDepth: number;
  maxEntries: number;
}

/**
 * Read one folder into the walk: its files listed, its folders queued, until the entry cap. A folder
 * below the root that can't be read is skipped; the root itself throws, so a folder that is gone or
 * shut is never read as an empty one.
 */
async function readFolder(dir: string, folder: Pending, walk: Walk): Promise<void> {
  const reading = readdir(path.join(dir, folder.rel), { withFileTypes: true });
  const entries = folder.rel === "" ? await reading : await reading.catch(() => []);
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    if (++walk.seen > walk.maxEntries) return;
    const rel = joinRel(folder.rel, entry.name);
    if (entry.isFile()) walk.files.push(rel);
    else if (entersFolder(entry) && folder.depth < walk.maxDepth) walk.queue.push({ rel, depth: folder.depth + 1 });
  }
}

/**
 * The files of a folder as POSIX paths relative to it, breadth first and sorted within a folder:
 * links are neither walked nor listed, hidden and generated folders are skipped, folders deeper
 * than `maxDepth` are not read, and the walk stops after `maxEntries` entries. Throws when the folder
 * itself can't be read.
 */
export async function projectFiles(dir: string, limits: WalkLimits = {}): Promise<string[]> {
  const walk: Walk = {
    files: [],
    queue: [{ rel: "", depth: 0 }],
    seen: 0,
    maxDepth: limits.maxDepth ?? WALK.MaxDepth,
    maxEntries: limits.maxEntries ?? WALK.MaxEntries,
  };
  for (let next = walk.queue.shift(); next && walk.seen < walk.maxEntries; next = walk.queue.shift()) {
    await readFolder(dir, next, walk);
  }
  return walk.files;
}

/**
 * A game's studio.json as an object, which any agent process can write: read never through a link,
 * never blocking on a FIFO and never past {@link STUDIO_JSON_MAX_BYTES}. Null when it is missing,
 * is not such a file, does not parse or is not an object: a listing never waits on it.
 */
export async function readStudioRecord(dir: string): Promise<Record<string, unknown> | null> {
  const file = path.join(dir, "studio.json");
  return readOwnJsonForUpdate<Record<string, unknown>>(file, STUDIO_JSON_MAX_BYTES).catch(() => null);
}

/**
 * Whether studio.json records the web starter (`contractVersion`, a number), as Genex writes it, or
 * a compiled game's stack (C++ · raylib, Rust · wgpu): Studio builds that game's page itself, so it
 * is served as a web game at the root though no page of its own is there.
 */
async function recordsWebStarter(dir: string): Promise<boolean> {
  const meta = await readStudioRecord(dir);
  if (typeof meta?.contractVersion === "number") return true;
  return isGameStack(meta?.stack) && isCompiledStack(meta.stack);
}

/**
 * The facts a folder holds by its files: the core table, then `pluginRules` (the enabled plugins'
 * `detect`). A web starter or a compiled game's stack recorded in studio.json counts as a web game
 * at the root even while its page is missing. Throws when the folder can't be read.
 */
export async function detectFacts(dir: string, pluginRules: readonly SourcedFactRule[]): Promise<ProjectFact[]> {
  const facts = factsOfFiles(await projectFiles(dir), [...CORE_RULES, ...pluginRules]);
  if (hasFact(facts, CoreFact.WebGame, ".") || !(await recordsWebStarter(dir))) return facts;
  return settleFacts([{ id: CoreFact.WebGame, path: ".", source: FactSource.Core }, ...facts]);
}
