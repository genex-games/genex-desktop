/**
 * Builds an AA+ evidence bundle from a finished Genex run: the integration head's judge shots and
 * their pixel statistics (`director/health_<head>/`), a camera→role map the operator writes for the
 * game's cameras, and a facts file carrying what the shots cannot show (look facts, the provenance
 * audit, per-tick motion and exposure tracks). Read only from the run; images are copied by base
 * name from the shot folder's `screenshots/`, never through a path a verdict names.
 */
import fs from "node:fs";
import path from "node:path";
import {
  AAA_EVIDENCE_SCHEMA,
  type AaaCapture,
  type AaaEvidence,
  EVIDENCE_FILE,
  FactSource,
  parseEvidence,
} from "./evidence.ts";
import { isFixedRole } from "./honest.ts";
import type { AaaPrompt } from "./suite.ts";

/** The schema tag a facts file carries. */
export const AAA_FACTS_SCHEMA = "genex-aaa-facts/1";
/** Where the copied images go inside a bundle. */
export const CAPTURES_DIR = "captures";
/** A shot image's base name: letters, digits, dashes, underscores and dots, ending .jpg or .png. */
const SHOT_FILE = /^[A-Za-z0-9_.-]+\.(?:jpe?g|png)$/;
const HEAD_DIGITS = 8;

/** Why a collect stopped before writing. */
export const CollectProblem = {
  NoReport: "no-report",
  NoShots: "no-shots",
  BadRoles: "bad-roles",
  BadFacts: "bad-facts",
} as const;
export type CollectProblem = (typeof CollectProblem)[keyof typeof CollectProblem];

/** A collect refused, with its code. */
export class CollectError extends Error {
  readonly problem: CollectProblem;
  constructor(problem: CollectProblem, detail: string) {
    super(`aaa collect (${problem}): ${detail}`);
    this.name = "CollectError";
    this.problem = problem;
  }
}

/** What to collect. */
export interface CollectInput {
  prompt: AaaPrompt;
  runDir: string;
  /** The judge-shot folder; by default the run's `director/health_<head>`. */
  shotsDir: string | null;
  /** Camera name → suite view role. */
  roles: Readonly<Record<string, string>>;
  /** A `genex-aaa-facts/1` object, or null. */
  facts: unknown;
  /** Whether the shots were taken with stylised post off; null when unknown. */
  clean: boolean | null;
  outDir: string;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** The run's report: its id, goal and integration head. */
function readRunReport(runDir: string): { runId: string | null; goal: string; head: string | null; game: string } {
  const file = path.join(runDir, "report.json");
  if (!fs.existsSync(file)) throw new CollectError(CollectProblem.NoReport, "the run folder has no report.json");
  const report = readJson(file);
  if (!isObject(report)) throw new CollectError(CollectProblem.NoReport, "report.json is not an object");
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  return {
    runId: text(report.runId),
    goal: text(report.goal) ?? "",
    head: text(report.integrationHead),
    game: text(report.project) ?? "unknown",
  };
}

function defaultShotsDir(runDir: string, head: string | null): string {
  if (!head) throw new CollectError(CollectProblem.NoShots, "the run has no integration head; pass --shots");
  return path.join(runDir, "director", `health_${head.slice(0, HEAD_DIGITS)}`);
}

/** One verdict shot as a capture, its image copied into the bundle; null when its files are missing. */
function shotCapture(
  shot: Json,
  shotsDir: string,
  input: CollectInput,
  fractions: Readonly<Record<string, number>>,
): AaaCapture | null {
  const camera = typeof shot.camera === "string" ? shot.camera : null;
  const base = typeof shot.path === "string" ? path.basename(shot.path) : "";
  if (!camera || !SHOT_FILE.test(base)) return null;
  const image = path.join(shotsDir, "screenshots", base);
  const statsFile = image.replace(/\.(?:jpe?g|png)$/, ".stats.json");
  if (!fs.existsSync(image) || !fs.existsSync(statsFile)) return null;
  const stats = readJson(statsFile);
  if (!isObject(stats) || !Array.isArray(stats.histogram)) return null;
  const dark = stats.histogram[0];
  fs.mkdirSync(path.join(input.outDir, CAPTURES_DIR), { recursive: true });
  fs.copyFileSync(image, path.join(input.outDir, CAPTURES_DIR, base));
  return {
    role: input.roles[camera] ?? null,
    camera,
    image: `${CAPTURES_DIR}/${base}`,
    width: Number(stats.width),
    height: Number(stats.height),
    clean: input.clean,
    native: null,
    subjectFraction: fractions[camera] ?? null,
    meanLuma: Number(stats.meanLuma),
    darkFraction: typeof dark === "number" ? dark : 0,
    source: FactSource.Probe,
  };
}

function readShots(shotsDir: string, input: CollectInput, fractions: Readonly<Record<string, number>>): AaaCapture[] {
  const verdictFile = path.join(shotsDir, "verdict.json");
  if (!fs.existsSync(verdictFile))
    throw new CollectError(CollectProblem.NoShots, "the shot folder has no verdict.json");
  const verdict = readJson(verdictFile);
  const shots = isObject(verdict) && Array.isArray(verdict.shots) ? verdict.shots : [];
  const captures = shots
    .filter(isObject)
    .map((shot) => shotCapture(shot, shotsDir, input, fractions))
    .filter((capture) => capture !== null);
  if (!captures.length) throw new CollectError(CollectProblem.NoShots, "no shot has both an image and its stats");
  return captures;
}

function checkRoles(prompt: AaaPrompt, roles: Readonly<Record<string, string>>): void {
  const known = new Set(prompt.views.map((view) => view.role));
  const unknown = Object.values(roles).filter((role) => !known.has(role) && !isFixedRole(role));
  if (unknown.length)
    throw new CollectError(CollectProblem.BadRoles, `not a view of ${prompt.id}: ${unknown.join(", ")}`);
}

function factsOf(raw: unknown): Json {
  if (raw === null) return {};
  if (!isObject(raw) || raw.schema !== AAA_FACTS_SCHEMA)
    throw new CollectError(CollectProblem.BadFacts, `a facts file carries schema ${AAA_FACTS_SCHEMA}`);
  return raw;
}

/** Whether a run was given the prompt's brief: the goal opens with it (the harness appends its origin line). */
function briefOf(goal: string, prompt: AaaPrompt): boolean {
  return goal === prompt.brief || goal.startsWith(`${prompt.brief} `);
}

/** Collect, validate and write `<outDir>/evidence.json`; returns the bundle. */
export function collectEvidence(input: CollectInput): AaaEvidence {
  checkRoles(input.prompt, input.roles);
  const facts = factsOf(input.facts);
  const report = readRunReport(input.runDir);
  const shotsDir = input.shotsDir ?? defaultShotsDir(input.runDir, report.head);
  const captures = [
    ...readShots(
      shotsDir,
      input,
      isObject(facts.subjectFractions) ? (facts.subjectFractions as Record<string, number>) : {},
    ),
    ...((facts.captures as AaaCapture[] | undefined) ?? []),
  ];
  const evidence = parseEvidence({
    schema: AAA_EVIDENCE_SCHEMA,
    promptId: input.prompt.id,
    promptVersion: briefOf(report.goal, input.prompt) ? input.prompt.version : null,
    subject: {
      game: report.game,
      head: report.head,
      runId: report.runId,
      preset: typeof facts.preset === "string" ? facts.preset : null,
      destination: null,
    },
    captures,
    surfaces: facts.surfaces ?? null,
    props: facts.props ?? null,
    flatCoverage: facts.flatCoverage ?? null,
    motion: facts.motion ?? [],
    exposure: facts.exposure ?? [],
    characters: facts.characters ?? null,
    poses: facts.poses ?? null,
    place: facts.place ?? null,
    lookFeatures: facts.lookFeatures ?? null,
    store: facts.store ?? null,
  });
  fs.writeFileSync(path.join(input.outDir, EVIDENCE_FILE), `${JSON.stringify(evidence, null, 2)}\n`);
  return evidence;
}
