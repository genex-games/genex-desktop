/**
 * The facts a project folder holds on disk (`shared/project-facts.ts`): a bounded walk of its files
 * matched against the core table and the rules enabled plugins add. The folder is the agent's and
 * the person's, so the walk only reads: it never follows a link, stays a few folders deep and stops
 * after a fixed number of folders. Only the files a rule can name are kept, so a folder of other
 * files (an agent's thousands of screenshots) never uses up the walk before it reaches a project.
 */
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  anyFileGlob,
  CORE_FACT_RULES,
  CoreFact,
  FactSource,
  foundFacts,
  hasFact,
  NOT_WALKED,
  type ProjectFact,
  type SourcedFactRule,
  settleFacts,
} from "../shared/project-facts.ts";
import { readJsonIfExists } from "./fsx.ts";

/**
 * How deep and how wide one walk goes: deep enough for `a/ProjectSettings/…`, never a whole disk.
 * Folders read bound what a walk costs; files listed bound what it keeps.
 */
const WALK = { MaxDepth: 4, MaxFolders: 2000, MaxFiles: 4000 } as const;

/** The core table with its source, first in every detection so a core fact wins a tie. */
const CORE_RULES: readonly SourcedFactRule[] = CORE_FACT_RULES.map((rule) => ({ rule, source: FactSource.Core }));

/** How far a walk may go, and which files it lists. */
export interface WalkLimits {
  maxDepth?: number;
  /** The most folders it reads, its root among them. */
  maxFolders?: number;
  /** The most files it lists; a file `keep` leaves out never counts. */
  maxFiles?: number;
  /** Which files it lists, by POSIX path relative to the root: every file when left out. */
  keep?: (rel: string) => boolean;
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

/** One walk in progress: the files kept, the folders still to read, and how many it has read. */
interface Walk {
  files: string[];
  queue: Pending[];
  read: number;
  maxDepth: number;
  maxFolders: number;
  maxFiles: number;
  keep: (rel: string) => boolean;
}

/** Whether the walk still reads another folder: under both of its caps. */
const walkGoesOn = (walk: Walk): boolean => walk.read < walk.maxFolders && walk.files.length < walk.maxFiles;

/**
 * Read one folder into the walk: the files it keeps listed, its folders queued while the folder cap
 * leaves room for them, until the file cap. A folder below the root that can't be read is skipped;
 * the root itself throws, so a folder that is gone or shut is never read as an empty one.
 */
async function readFolder(dir: string, folder: Pending, walk: Walk): Promise<void> {
  walk.read++;
  const reading = readdir(path.join(dir, folder.rel), { withFileTypes: true });
  const entries = folder.rel === "" ? await reading : await reading.catch(() => []);
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    const rel = joinRel(folder.rel, entry.name);
    const roomForFolder = walk.read + walk.queue.length < walk.maxFolders && folder.depth < walk.maxDepth;
    if (entry.isFile() && walk.keep(rel)) walk.files.push(rel);
    else if (roomForFolder && entersFolder(entry)) walk.queue.push({ rel, depth: folder.depth + 1 });
    if (walk.files.length >= walk.maxFiles) return;
  }
}

/**
 * The files of a folder as POSIX paths relative to it, breadth first and sorted within a folder:
 * links are neither walked nor listed, hidden and generated folders are skipped, folders deeper
 * than `maxDepth` are not read, and the walk stops after `maxFolders` folders or `maxFiles` kept
 * files. Throws when the folder itself can't be read.
 */
export async function projectFiles(dir: string, limits: WalkLimits = {}): Promise<string[]> {
  const walk: Walk = {
    files: [],
    queue: [{ rel: "", depth: 0 }],
    read: 0,
    maxDepth: limits.maxDepth ?? WALK.MaxDepth,
    maxFolders: limits.maxFolders ?? WALK.MaxFolders,
    maxFiles: limits.maxFiles ?? WALK.MaxFiles,
    keep: limits.keep ?? (() => true),
  };
  for (let next = walk.queue.shift(); next && walkGoesOn(walk); next = walk.queue.shift()) {
    await readFolder(dir, next, walk);
  }
  return walk.files;
}

/** The files of a folder some rule's file glob names (`projectFiles`): all its facts are read from. */
export async function ruleFiles(dir: string, rules: readonly SourcedFactRule[]): Promise<string[]> {
  return projectFiles(dir, { keep: anyFileGlob(rules.flatMap(({ rule }) => rule.files)) });
}

/** Whether studio.json records the web starter (`contractVersion`, a number), as Genex writes it. */
async function recordsWebStarter(dir: string): Promise<boolean> {
  const meta = await readJsonIfExists<{ contractVersion?: unknown }>(path.join(dir, "studio.json")).catch(() => null);
  return typeof meta?.contractVersion === "number";
}

/**
 * The facts a folder's files give before they are settled (`foundFacts`): the core table, then
 * `pluginRules` (the enabled plugins' `detect`), so a web game below another is still there. A web
 * starter recorded in studio.json counts as a web game at the root even while its page is missing.
 * Throws when the folder can't be read.
 */
export async function detectFoundFacts(dir: string, pluginRules: readonly SourcedFactRule[]): Promise<ProjectFact[]> {
  const rules = [...CORE_RULES, ...pluginRules];
  const found = foundFacts(await ruleFiles(dir, rules), rules);
  if (hasFact(found, CoreFact.WebGame, ".") || !(await recordsWebStarter(dir))) return found;
  return [{ id: CoreFact.WebGame, path: ".", source: FactSource.Core }, ...found];
}

/** The facts a folder holds by its files (`detectFoundFacts`), settled. Throws when the folder can't be read. */
export async function detectFacts(dir: string, pluginRules: readonly SourcedFactRule[]): Promise<ProjectFact[]> {
  return settleFacts(await detectFoundFacts(dir, pluginRules));
}
