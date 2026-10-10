/** Read-only supplementation for durable reports predating structured evidence events. */
import type { Dirent } from "node:fs";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { InteractionSource, type RunSummary } from "../shared/run-summary.ts";
import { isBelow } from "../substrate/paths.ts";

/** The longest report the supplement reads, in characters. */
const REPORT_MAX_CHARS = 2_000_000;
/** The base stage's verdict has always been capped one character lower: it was read only below the cap. */
const BASE_REPORT_MAX_CHARS = REPORT_MAX_CHARS - 1;
/** A run id that is also a folder name. */
const RUN_ID = /^[a-zA-Z0-9_-]+$/;
/** Where a director kept the build it started from, newest layout first. */
const BASE_STAGES = ["base", "contract", "start"] as const;

/** A director report (`verdict.json`, `playtest.json`), as loosely as old runs wrote it. */
interface DirectorReport {
  commit?: unknown;
  head?: unknown;
  target?: unknown;
  shots?: unknown;
  answers?: Record<string, unknown> | null;
  answer?: { question?: unknown; yes?: unknown; note?: unknown; camera?: unknown } | null;
}

interface Shot {
  camera?: unknown;
  path?: unknown;
}

/** The build the run delivered, by the most exact head it recorded. */
function deliveredHead(summary: RunSummary): string | null | undefined {
  return summary.deliveredSourceHead ?? summary.deliveredHead ?? summary.head;
}

/**
 * A report inside the director folder, parsed; undefined when it escapes the folder, is missing,
 * longer than `maxChars` or not JSON. Old reports hold anything, so the value is read loosely.
 */
async function readReport(dir: string, file: string, maxChars = REPORT_MAX_CHARS): Promise<DirectorReport | undefined> {
  const resolved = await realpath(file).catch(() => null);
  if (!resolved || !isBelow(dir, resolved)) return undefined;
  const raw = await readFile(resolved, "utf8").catch(() => null);
  if (!raw || raw.length > maxChars) return undefined;
  try {
    return JSON.parse(raw) as DirectorReport;
  } catch {
    return undefined;
  }
}

/** The first saved shot that still lives under `captureRoot`, the `default` camera first. */
async function savedCapture(shots: unknown, captureRoot: string): Promise<string | undefined> {
  if (!Array.isArray(shots)) return undefined;
  const ordered = [...(shots as Array<Shot | null>)].sort(
    (a, b) => Number(b?.camera === "default") - Number(a?.camera === "default"),
  );
  for (const shot of ordered) {
    if (typeof shot?.path !== "string") continue;
    const file = await realpath(shot.path).catch(() => null);
    if (file && isBelow(captureRoot, file)) return file;
  }
  return undefined;
}

/** The build the director started from: its capture, and the current one too when nothing moved since. */
async function supplementBaseCapture(summary: RunSummary, dir: string): Promise<void> {
  for (const stage of BASE_STAGES) {
    // Missing or partial evidence remains unavailable.
    const base = await readReport(dir, path.join(dir, stage, "verdict.json"), BASE_REPORT_MAX_CHARS);
    if (!base?.commit) continue;
    const capture = await savedCapture(base.shots, stage === "start" ? path.dirname(dir) : dir);
    if (!capture) continue;
    summary.captures = {
      ...summary.captures,
      base: capture,
      ...(deliveredHead(summary) === base.commit ? { current: capture } : {}),
    };
    return;
  }
}

function playtestStatus(pass: boolean | null | undefined): "passed" | "failed" | "incomplete" {
  if (pass === true) return "passed";
  if (pass === false) return "failed";
  return "incomplete";
}

/**
 * Older playtest reports have no revision. Preserve that limitation rather than attaching
 * their result to whichever integration happened to be last.
 */
async function supplementPlaytests(summary: RunSummary, dir: string, entries: readonly Dirent[]): Promise<void> {
  if (summary.evidence.some((e) => e.category === "interaction")) return;
  for (const folder of entries.filter((e) => e.isDirectory() && /^play_\d+$/.test(e.name))) {
    // Corrupt historical reports do not become evidence.
    const report = await readReport(dir, path.join(dir, folder.name, "playtest.json"));
    for (const [check, value] of Object.entries(report?.answers ?? {})) {
      const answer = value as { pass?: boolean | null; note?: string };
      if (!answer || typeof answer !== "object") continue;
      summary.evidence.push({
        id: `${folder.name}:${check}`,
        head: null,
        category: "interaction",
        label: `Independent playtest ${folder.name.slice(5)} — ${check} (question not recorded)`,
        status: playtestStatus(answer.pass),
        note: typeof answer.note === "string" ? answer.note : null,
        source: InteractionSource.IndependentPlaytester,
      });
    }
  }
}

/** A structural judge also captures the build, even without a separate visual question. */
async function noteJudgeCapture(summary: RunSummary, dir: string, report: DirectorReport): Promise<void> {
  const currentHead = deliveredHead(summary);
  if (!currentHead || report.head !== currentHead) return;
  if (report.target && report.target !== "integration") return;
  const capture = await savedCapture(report.shots, dir);
  if (capture) summary.captures = { ...summary.captures, current: capture };
}

/** The frame a judge answered from, when it still lives under the director folder. */
async function answeredShot(report: DirectorReport, dir: string): Promise<string | null> {
  const shots = Array.isArray(report.shots) ? (report.shots as Shot[]) : [];
  const shot = shots.find((candidate) => candidate.camera === report.answer?.camera);
  if (typeof shot?.path !== "string") return null;
  const capture = await realpath(shot.path).catch(() => null);
  return capture && isBelow(dir, capture) ? capture : null;
}

/** A visual answer the log already holds gains the judge's note and frame, when they agree. */
async function noteJudgeAnswer(summary: RunSummary, dir: string, report: DirectorReport): Promise<void> {
  const head = report.head;
  const question = report.answer?.question;
  if (typeof head !== "string" || typeof question !== "string") return;
  const sameQuestion = (e: RunSummary["evidence"][number]) =>
    e.head === head && e.category === "visual" && e.label === question;
  const existing = summary.evidence.find(sameQuestion);
  const yes = report.answer?.yes;
  if (!existing || typeof yes !== "boolean") return;
  if (existing.status !== (yes ? "passed" : "failed")) return;
  const note = report.answer?.note;
  existing.note = existing.note ?? (typeof note === "string" ? note : null);
  const capture = await answeredShot(report, dir);
  if (capture) existing.capture = capture;
}

async function supplementJudges(summary: RunSummary, dir: string, entries: readonly Dirent[]): Promise<void> {
  const folders = entries
    .filter((e) => e.isDirectory() && /^judge_\d+$/.test(e.name))
    .sort((a, b) => Number(a.name.slice(6)) - Number(b.name.slice(6)));
  for (const folder of folders) {
    const report = await readReport(dir, path.join(dir, folder.name, "verdict.json"));
    if (report === undefined) continue;
    await noteJudgeCapture(summary, dir, report);
    await noteJudgeAnswer(summary, dir, report);
  }
}

/**
 * A director may close after a health pass without calling the visual judge. Older health
 * reports record the exact head but omit shots, whose default path is still durable.
 */
async function supplementHealthCapture(summary: RunSummary, dir: string, entries: readonly Dirent[]): Promise<void> {
  if (summary.captures?.current) return;
  for (const folder of entries.filter((e) => e.isDirectory() && /^(close|health)_[a-f0-9]+$/.test(e.name))) {
    // Incomplete reports do not become evidence.
    const report = await readReport(dir, path.join(dir, folder.name, "verdict.json"));
    if (!report?.head || report.head !== deliveredHead(summary)) continue;
    const defaultShot = { path: path.join(dir, folder.name, "screenshots/default.jpg") };
    const capture = await savedCapture(report.shots ?? [defaultShot], dir);
    if (capture) {
      summary.captures = { ...summary.captures, current: capture };
      return;
    }
  }
}

export async function supplementRunEvidence(summary: RunSummary, runsRoot: string): Promise<void> {
  if (!RUN_ID.test(summary.runId)) return;
  const root = await realpath(runsRoot).catch(() => null);
  if (!root) return;
  const dir = await realpath(path.join(root, summary.runId, "director")).catch(() => null);
  if (!dir || !isBelow(root, dir)) return;
  const entries = await readdir(dir, { withFileTypes: true });
  await supplementBaseCapture(summary, dir);
  await supplementPlaytests(summary, dir, entries);
  await supplementJudges(summary, dir, entries);
  await supplementHealthCapture(summary, dir, entries);
}
