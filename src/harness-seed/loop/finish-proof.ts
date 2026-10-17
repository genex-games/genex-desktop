/**
 * The lead's proof at a finish, as its reviewer reads it: the files it names in its own folder and
 * the run's job results.
 *
 * A name, relative to the lead's folder or a full path inside it, is read only when it is a regular
 * file inside that folder once every link is followed (`folder-paths.ts`), and the file opened is
 * still that one (others may write the folder while it is read); a PNG or JPEG becomes a picture
 * (kept as a run artifact, so it can be recorded and shown), any other file text, clipped. Everything else comes back as a one-line
 * refusal the reviewer reads beside the rest. A job is told by its title, how it ended and how long
 * it ran, never by its command.
 */
import { constants as FS } from "node:fs";
import { type FileHandle, open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { AnyRecord, HarnessCtx, Run } from "../types/harness.d.ts";
import { pathShapeProblem, realInside } from "./folder-paths.ts";
import { HostMethod } from "./host-methods.ts";
import { InteractionStatus } from "./interaction-evidence.ts";
import { InteractionObjective, InteractionSource } from "./interaction-words.ts";
import { JobState } from "./jobs/contract.ts";
import { isPlainRecord } from "./json.ts";
import { type CaptureImage, REVIEW_PICTURE_MAX_BYTES } from "./observers.ts";
import { EventKind, RunEvent } from "./run-events.ts";
import { clipMarked } from "./text.ts";
import { minutes } from "./time.ts";

/** How many names of the lead's proof are read; the rest are refused in one line. */
export const MAX_PROOF_FILES = 16;
/** The largest proof file read. */
export const PROOF_FILE_MAX_BYTES = 8 * 1024 * 1024;
/** How much of one text file the reviewer reads. */
export const PROOF_TEXT_CHARS = 4_000;
/** How much text of all the proof files together the reviewer reads. */
export const PROOF_TEXT_TOTAL = 12_000;
/** How many of the run's ended jobs the reviewer is told of (the newest). */
export const MAX_JOB_LINES = 12;

/** How long a name or a job title reads in a line. */
const NAME_CHARS = 120;
/** Where the lead's pictures land among the run's artifacts, unless the caller names a round. */
const PROOF_ARTIFACTS = "finish/proof";
/** The first bytes of the pictures a reviewer can look at. */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this finds
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this replaces
const CONTROL_RUNS = /[\u0000-\u001f\u007f-\u009f]+/g;
/** How a proof file is opened: read-only, never through a link at its name, never waiting on a FIFO (each flag the platform has). */
const READ_FLAGS = FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0);

/** Why a proof file is not read, and how a job is told: the reviewer reads these lines. */
const MESSAGE = {
  refused: (name: string, why: string) => `${name}: not a file in your folder (${why})`,
  notName: "not a name",
  controlCharacters: "its name has a line break or a control character",
  notFile: "not a regular file",
  tooLarge: `larger than ${PROOF_FILE_MAX_BYTES / (1024 * 1024)} MiB`,
  binary: "a binary file that is no PNG or JPEG",
  unreadable: "could not be read",
  changed: "it changed while it was read",
  notKept: "the picture could not be kept",
  pictureTooLarge: `a picture larger than ${(REVIEW_PICTURE_MAX_BYTES / 1_000_000).toFixed(2)} MB, more than a reviewer can be handed: name a smaller one`,
  pastCap: (count: number) =>
    `${count} more ${count === 1 ? "name was" : "names were"} not read: at most ${MAX_PROOF_FILES} files are`,
  job: (title: string, state: string, exitCode: number | null, ran: number | null) =>
    [`${title}: ${state}`, exitCode === null ? "" : `, exit code ${exitCode}`, ran === null ? "" : `, ${ran} min`].join(
      "",
    ),
} as const;

/** One text file of the proof, as the reviewer reads it. */
export interface ProofText {
  name: string;
  text: string;
  clipped: boolean;
}

/** What the lead's proof holds for its reviewer: its pictures, its text files and the names refused. */
export interface Proof {
  names: string[];
  images: CaptureImage[];
  texts: ProofText[];
  refused: string[];
  /** The text files' excerpts were left out of the reviewer's brief to fit its model. */
  excerptsCut?: boolean;
}

/** A name as a line shows it: one line, clipped. */
const shown = (name: string): string => clipMarked(name.replace(CONTROL_RUNS, " ").trim(), NAME_CHARS);

/** A picture's type by its first bytes (a PNG or a JPEG), or null for anything else. */
export function pictureType(bytes: Buffer): string | null {
  const starts = (magic: number[]) => magic.every((byte, index) => bytes[index] === byte);
  if (starts(PNG_MAGIC)) return "image/png";
  return starts(JPEG_MAGIC) ? "image/jpeg" : null;
}

/**
 * A name as a path relative to the folder: a relative one as it is (with Windows separators made
 * `/` there), a full path inside the folder (as spelled, or by its real path) relative to it; a full
 * path elsewhere is left as it is, and its shape refuses it.
 */
async function relativeName(folder: string, name: string): Promise<string> {
  const spelled = process.platform === "win32" ? name.replaceAll("\\", "/") : name;
  if (!path.isAbsolute(spelled)) return spelled;
  const real = await realpath(folder).catch(() => folder);
  for (const base of [folder, real]) {
    const rel = path.relative(base, spelled);
    const inside = rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
    if (inside) return rel.split(path.sep).join("/");
  }
  return spelled;
}

/** Where a name really is inside the folder, or why it is refused (by its shape, a link that leads out, nothing there). */
async function placed(folder: string, asked: string): Promise<{ real: string } | { problem: string }> {
  if (CONTROL_CHARACTERS.test(asked)) return { problem: MESSAGE.controlCharacters };
  const name = await relativeName(folder, asked);
  const shape = pathShapeProblem(name);
  if (shape) return { problem: shape };
  const inside = await realInside(folder, name);
  if ("problem" in inside) return inside;
  const info = await stat(inside.real).catch(() => null);
  if (!info?.isFile()) return { problem: MESSAGE.notFile };
  return info.size > PROOF_FILE_MAX_BYTES ? { problem: MESSAGE.tooLarge } : inside;
}

/** At most `PROOF_FILE_MAX_BYTES` of an open file (its size was checked; one that grew meanwhile is no file). */
async function readCapped(handle: FileHandle): Promise<Buffer | null> {
  try {
    const buffer = Buffer.alloc(PROOF_FILE_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead > PROOF_FILE_MAX_BYTES ? null : buffer.subarray(0, bytesRead);
  } catch {
    return null;
  }
}

/** Whether the name still leads, inside the folder, to the very file `opened` is. */
async function stillThere(folder: string, name: string, opened: { dev: number; ino: number }): Promise<boolean> {
  const again = await placed(folder, name);
  const named = "real" in again ? await stat(again.real).catch(() => null) : null;
  return Boolean(named && named.dev === opened.dev && named.ino === opened.ino);
}

/**
 * The bytes of one proof file, or why it is not read: placed inside the folder, opened without
 * following a link at its name or waiting on a FIFO, a regular file within the cap by its handle, and
 * still the file its name leads to inside the folder, so a file or a folder on the way swapped after
 * the check is refused. `between` runs after the check, before the open: a test's swap.
 */
export async function readProofFile(
  folder: string,
  name: string,
  between?: () => Promise<void>,
): Promise<{ bytes: Buffer } | { problem: string }> {
  const where = await placed(folder, name);
  if ("problem" in where) return where;
  await between?.();
  const handle = await open(where.real, READ_FLAGS).catch(() => null);
  if (!handle) return { problem: MESSAGE.unreadable };
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { problem: MESSAGE.notFile };
    if (info.size > PROOF_FILE_MAX_BYTES) return { problem: MESSAGE.tooLarge };
    if (!(await stillThere(folder, name, info))) return { problem: MESSAGE.changed };
    const bytes = await readCapped(handle);
    return bytes ? { bytes } : { problem: MESSAGE.unreadable };
  } finally {
    await handle.close().catch(() => {});
  }
}

/** A file's name among the run's artifacts: plain characters only. */
const artifactName = (name: string): string => path.basename(name).replace(/[^A-Za-z0-9._-]+/g, "-");

/** Keep a picture as a run artifact, so it can be recorded and shown; null when the host could not. */
async function keepPicture(ctx: HarnessCtx, run: Run, name: string, data: Buffer): Promise<string | null> {
  try {
    const file = await ctx.call(HostMethod.RunArtifact, { runId: run.runId, name, base64: data.toString("base64") });
    return typeof file === "string" ? file : null;
  } catch {
    return null;
  }
}

/** One name of the proof read into `proof`; `budget` is the text the reviewer may still read. */
async function readOne(
  ctx: HarnessCtx,
  scope: { run: Run; folder: string; prefix: string },
  name: string,
  index: number,
  proof: Proof,
): Promise<void> {
  const read = await readProofFile(scope.folder, name);
  if ("problem" in read) return void proof.refused.push(MESSAGE.refused(shown(name), read.problem));
  const { bytes } = read;
  const mimeType = pictureType(bytes);
  if (mimeType && bytes.length > REVIEW_PICTURE_MAX_BYTES)
    return void proof.refused.push(MESSAGE.refused(shown(name), MESSAGE.pictureTooLarge));
  if (mimeType) {
    const file = await keepPicture(ctx, scope.run, `${scope.prefix}/${index + 1}-${artifactName(name)}`, bytes);
    if (!file) return void proof.refused.push(MESSAGE.refused(shown(name), MESSAGE.notKept));
    return void proof.images.push({ name: shown(name), file, mimeType, data: bytes.toString("base64") });
  }
  if (bytes.includes(0)) return void proof.refused.push(MESSAGE.refused(shown(name), MESSAGE.binary));
  const used = proof.texts.reduce((sum, text) => sum + text.text.length, 0);
  const room = Math.min(PROOF_TEXT_CHARS, Math.max(0, PROOF_TEXT_TOTAL - used));
  const text = bytes.toString("utf8");
  proof.texts.push({ name: shown(name), text: text.slice(0, room), clipped: text.length > room });
}

/**
 * The names the lead gave that stand for paths inside its folder, relative to it (`/`-separated): a
 * name its shape refuses, or a full path elsewhere, is none. At most `MAX_PROOF_FILES`, as read.
 */
export async function proofPathsIn(folder: string, names: readonly unknown[]): Promise<string[]> {
  const paths: string[] = [];
  for (const name of askedNames(names).slice(0, MAX_PROOF_FILES)) {
    if (CONTROL_CHARACTERS.test(name)) continue;
    const rel = await relativeName(folder, name);
    if (!pathShapeProblem(rel)) paths.push(rel);
  }
  return paths;
}

/** The names the lead gave, trimmed: anything that is not text is no name. */
const askedNames = (names: readonly unknown[]): string[] =>
  names.flatMap((name) => (typeof name === "string" && name.trim() ? [name.trim()] : []));

/** The names a finish check reads, as a record shows them: at most `MAX_PROOF_FILES`, each one plain line. */
export function proofNamesOf(names: readonly unknown[]): string[] {
  return askedNames(names).slice(0, MAX_PROOF_FILES).map(shown);
}

/**
 * The files the lead names as proof, read inside its folder: at most `MAX_PROOF_FILES` names (the
 * rest refused in one line), each a picture (kept under `prefix` among the run's artifacts) or text
 * (clipped, `PROOF_TEXT_TOTAL` in all), or a refusal line. Never throws; reads nothing outside.
 */
export async function readProof(
  ctx: HarnessCtx,
  run: Run,
  leadFolder: string,
  names: readonly unknown[],
  prefix = PROOF_ARTIFACTS,
): Promise<Proof> {
  const asked = askedNames(names);
  const considered = asked.slice(0, MAX_PROOF_FILES);
  const proof: Proof = { names: considered.map(shown), images: [], texts: [], refused: [] };
  const scope = { run, folder: leadFolder, prefix };
  for (const [index, name] of considered.entries()) await readOne(ctx, scope, name, index, proof);
  if (asked.length > considered.length) proof.refused.push(MESSAGE.pastCap(asked.length - considered.length));
  return proof;
}

/** The jobs of the host's answer, whatever an older or edited host sent. */
function jobsOf(answer: unknown): AnyRecord[] {
  const jobs = isPlainRecord(answer) ? answer.jobs : null;
  return Array.isArray(jobs) ? jobs.filter(isPlainRecord) : [];
}

/** The order a job ended in, by the host's sequence. */
const endSeqOf = (job: AnyRecord): number => (typeof job.endSeq === "number" ? job.endSeq : 0);

/** One ended job as a line: its title, how it ended, its exit code and how long it ran; never its command. */
function jobLine(job: AnyRecord): string {
  const ran = typeof job.durationMs === "number" ? minutes(job.durationMs) : null;
  const exitCode = typeof job.exitCode === "number" ? job.exitCode : null;
  return MESSAGE.job(shown(String(job.title ?? "")), shown(String(job.state ?? "")), exitCode, ran);
}

/**
 * The run's ended jobs as lines for its reviewer (the newest `MAX_JOB_LINES`, oldest first). A host
 * without `jobs.list`, or any failure, is no lines.
 */
export async function jobLines(ctx: HarnessCtx, run: Run): Promise<string[]> {
  const answer = await ctx.call(HostMethod.JobsList, { project: run.project, runId: run.runId }).catch(() => null);
  const ended = jobsOf(answer).filter((job) => job.state !== JobState.Running && typeof job.title === "string");
  ended.sort((a, b) => endSeqOf(a) - endSeqOf(b));
  return ended.slice(-MAX_JOB_LINES).map(jobLine);
}

/** How many blind judges' questions the reviewer is told of (the newest), and how much of each note. */
const MAX_JUDGE_LINES = 8;
const JUDGE_NOTE_CHARS = 300;

/** What a judge's answer rests on, in the reviewer's words. */
const JUDGE_BASIS = {
  verified: "studio-verified: Genex saw the goal state reached",
  word: "the judge's word",
} as const;

/** A judge's status as its answer. */
const judgeAnswer = (status: unknown): string => {
  if (status === InteractionStatus.Passed) return "yes";
  return status === InteractionStatus.Failed ? "no" : "no answer";
};

/** One judge record as the reviewer reads it: its question, its answer, what it rests on, its note. */
function judgeLine(payload: AnyRecord): string {
  const basis = payload.objective === InteractionObjective.StudioVerified ? JUDGE_BASIS.verified : JUDGE_BASIS.word;
  const note =
    typeof payload.note === "string" && payload.note ? ` — ${clipMarked(payload.note, JUDGE_NOTE_CHARS)}` : "";
  return `${clipMarked(String(payload.label ?? ""), NAME_CHARS)}: ${judgeAnswer(payload.status)} (${basis})${note}`;
}

/**
 * The blind judges' answers on this run (`judge_play`, the hands-on judge), for the reviewer: each
 * question's latest answer, newest last. A failed read is none.
 */
export async function judgeLines(ctx: HarnessCtx, run: Run, threadId: string): Promise<string[]> {
  const events = await ctx.call(HostMethod.EventsList, { threadId }).catch(() => []);
  const latest = new Map<string, AnyRecord>();
  for (const event of Array.isArray(events) ? events : []) {
    const data: unknown = isPlainRecord(event) ? event.data : null;
    if (!isPlainRecord(data) || data.type !== EventKind.Custom || data.event_type !== RunEvent.RunInteractionEvidence)
      continue;
    const payload = data.payload;
    if (!isPlainRecord(payload) || payload.runId !== run.runId) continue;
    if (payload.source !== InteractionSource.HandsOnJudge) continue;
    const label = String(payload.label ?? "");
    latest.delete(label);
    latest.set(label, payload);
  }
  return [...latest.values()].slice(-MAX_JUDGE_LINES).map(judgeLine);
}
