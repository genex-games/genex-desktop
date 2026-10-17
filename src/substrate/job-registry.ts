/**
 * Agent jobs on disk: one folder per job under `<root>/<game>/<id>/`, holding `job.json` (the
 * record) and `output.log` (what the job printed). The folder sits outside every writable root of
 * an agent process, so a record is only ever written by the app. A record that does not parse is
 * skipped and left as it is, never rewritten.
 */
import { open, rm } from "node:fs/promises";
import path from "node:path";
import { isEndedJob, type JobRecord } from "../shared/jobs.ts";
import { atomicWriteJson, isJsonObject, listDirs, readJsonIfExists } from "./fsx.ts";

/** A game name a job folder may carry: the names Genex gives games, nothing that climbs or nests. */
const PROJECT_NAME = /^[a-zA-Z0-9_-]+$/;
/** A job id: a random UUID as `randomUUID()` writes it. */
const JOB_ID = /^[0-9a-f-]{36}$/;
const RECORD_FILE = "job.json";
const LOG_FILE = "output.log";

/** Whether `name` may name a game's job folder. */
export function isJobProject(name: string): boolean {
  return PROJECT_NAME.test(name);
}

/** Whether `id` has the shape of a job id. */
export function isJobId(id: string): boolean {
  return JOB_ID.test(id);
}

/** The folder of one job. Callers check both names first. */
export function jobFolder(root: string, project: string, id: string): string {
  return path.join(root, project, id);
}

/** The log file of one job. */
export function jobLogFile(root: string, project: string, id: string): string {
  return path.join(jobFolder(root, project, id), LOG_FILE);
}

/** A parsed record that looks like one of ours, kept in its own game's folder, or null. */
function asRecord(value: unknown, project: string, id: string): JobRecord | null {
  if (!isJsonObject(value) || value.id !== id || typeof value.state !== "string") return null;
  if (!isJsonObject(value.owner) || value.owner.project !== project) return null;
  return value as unknown as JobRecord;
}

/** One job's record, or null when it is missing, does not parse or names another game. */
export async function readJobRecord(root: string, project: string, id: string): Promise<JobRecord | null> {
  const file = path.join(jobFolder(root, project, id), RECORD_FILE);
  const value = await readJsonIfExists<unknown>(file).catch(() => null);
  return asRecord(value, project, id);
}

/** Write a job's record in place of the last one. */
export async function writeJobRecord(root: string, record: JobRecord): Promise<void> {
  await atomicWriteJson(path.join(jobFolder(root, record.owner.project, record.id), RECORD_FILE), record);
}

/** The games that have job folders. */
export async function jobProjects(root: string): Promise<string[]> {
  return (await listDirs(root)).filter(isJobProject);
}

/** Every readable record of one game's jobs. */
export async function readGameJobs(root: string, project: string): Promise<JobRecord[]> {
  const ids = (await listDirs(path.join(root, project))).filter(isJobId);
  const records = await Promise.all(ids.map((id) => readJobRecord(root, project, id)));
  return records.filter((record): record is JobRecord => record !== null);
}

/** The highest end number among `records` (0 when none has ended). */
export function lastEndSeq(records: readonly JobRecord[]): number {
  return records.reduce((most, record) => Math.max(most, record.endSeq ?? 0), 0);
}

/**
 * Remove the folders of a game's oldest ended jobs beyond `keep`, by end number. A running job,
 * or one `busy` names, is never removed.
 */
export async function pruneEndedJobs(
  root: string,
  project: string,
  keep: number,
  busy: (id: string) => boolean,
): Promise<void> {
  const ended = (await readGameJobs(root, project)).filter((record) => isEndedJob(record) && !busy(record.id));
  ended.sort((a, b) => (b.endSeq ?? 0) - (a.endSeq ?? 0));
  for (const record of ended.slice(keep))
    await rm(jobFolder(root, project, record.id), { recursive: true, force: true });
}

/** How much of a log's end {@link tailLog} reads and hands back. */
export interface TailLimits {
  lines: number;
  maxChars: number;
  /** The most bytes read from the end of the file. */
  scanBytes: number;
  /** Keep only lines holding this text, as plain text. */
  contains?: string;
}

/** The end of a job's log: its last lines, and whether earlier output exists that is not shown. */
export interface JobTail {
  text: string;
  partial: boolean;
}

/** The last bytes of `file`, at most `scanBytes`, and where they start. */
async function readEnd(file: string, scanBytes: number): Promise<{ text: string; start: number } | null> {
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return null;
  try {
    const size = (await handle.stat()).size;
    const start = Math.max(0, size - scanBytes);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    return { text: buffer.subarray(0, bytesRead).toString("utf8"), start };
  } finally {
    await handle.close();
  }
}

/** The newest of `lines` that fit `limits`, oldest first. A single line too long keeps its end. */
function newestThatFit(lines: readonly string[], limits: TailLimits): string[] {
  const kept: string[] = [];
  let chars = 0;
  for (let i = lines.length - 1; i >= 0 && kept.length < limits.lines; i--) {
    const line = lines[i] ?? "";
    const cost = line.length + (kept.length > 0 ? 1 : 0);
    if (chars + cost > limits.maxChars) {
      if (kept.length === 0) kept.push(line.slice(-limits.maxChars));
      break;
    }
    kept.unshift(line);
    chars += cost;
  }
  return kept;
}

/**
 * The last lines of a log, read from its end only (at most `scanBytes`), so a log at its size cap
 * is never loaded whole. `contains` is matched as plain text, never as a pattern.
 */
export async function tailLog(file: string, limits: TailLimits): Promise<JobTail> {
  const end = await readEnd(file, limits.scanBytes);
  if (!end) return { text: "", partial: false };
  const lines = end.text.split("\n");
  // The first line read may be cut in the middle (or in a character): it is dropped.
  if (end.start > 0) lines.shift();
  if (lines.at(-1) === "") lines.pop();
  const { contains } = limits;
  const picked = contains ? lines.filter((line) => line.includes(contains)) : lines;
  const kept = newestThatFit(picked, limits);
  return { text: kept.join("\n"), partial: end.start > 0 || kept.length < picked.length };
}
