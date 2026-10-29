/**
 * The AA+ report: one graded entry per prompt run (grade, every check with the facts that decided
 * it, the blockers to the next grade) and the release gate over them. The gate passes when at
 * least `RELEASE_GATE.minPrompts` different suite prompts, each run on its current brief, were
 * graded and every graded run reached `RELEASE_GATE.minGrade`. Pure: the caller reads and writes.
 */
import { CheckResult } from "../vocabulary.ts";
import type { AaaEvidence, AaaSubject } from "./evidence.ts";
import { FactSource } from "./evidence.ts";
import {
  AaaGrade,
  blockersOf,
  type FloorCheck,
  GRADE_ORDER,
  gradeOf,
  rubricChecks,
  type TasteSummary,
} from "./rubric.ts";
import type { AaaPrompt } from "./suite.ts";

/** The schema tag a report carries. */
export const AAA_REPORT_SCHEMA = "genex-aaa-report/1";
/** The release gate (review section 7): three different prompts, every one at AA+ or better. */
export const RELEASE_GATE = { minPrompts: 3, minGrade: AaaGrade.AaPlus } as const;

/** One prompt run, graded. */
export interface AaaPromptReport {
  promptId: string;
  label: string;
  /** Whether the run was given the suite's current brief. */
  versionMatches: boolean;
  subject: AaaSubject;
  grade: AaaGrade;
  blockers: FloorCheck[];
  checks: FloorCheck[];
  taste: TasteSummary | null;
  tasteMissing: string[];
  /** How many facts in the bundle were reconstructed by hand rather than measured. */
  reconstructedFacts: number;
}

/** The release gate's verdict. */
export interface AaaGate {
  pass: boolean;
  /** Prompts that count toward the gate: graded on their current brief. */
  counted: string[];
  lines: string[];
}

/** A whole report. */
export interface AaaReport {
  schema: typeof AAA_REPORT_SCHEMA;
  generatedAt: string;
  tasteMode: string;
  prompts: AaaPromptReport[];
  gate: AaaGate;
}

function reconstructedCount(evidence: AaaEvidence): number {
  const sources = [
    ...evidence.captures.map((c) => c.source),
    ...(evidence.surfaces ?? []).map((s) => s.source),
    ...(evidence.props ?? []).map((p) => p.source),
    ...(evidence.flatCoverage ? [evidence.flatCoverage.source] : []),
    ...evidence.motion.map((t) => t.source),
    ...evidence.exposure.map((t) => t.source),
  ];
  return sources.filter((source) => source === FactSource.Reconstructed).length;
}

/** Grade one prompt run. */
export function gradePrompt(
  prompt: AaaPrompt,
  evidence: AaaEvidence,
  taste: { summary: TasteSummary | null; missing: string[] },
): AaaPromptReport {
  const checks = rubricChecks(prompt, evidence, taste.summary);
  const grade = gradeOf(checks);
  return {
    promptId: prompt.id,
    label: prompt.label,
    versionMatches: evidence.promptVersion === prompt.version,
    subject: evidence.subject,
    grade,
    blockers: blockersOf(checks, grade),
    checks,
    taste: taste.summary,
    tasteMissing: taste.missing,
    reconstructedFacts: reconstructedCount(evidence),
  };
}

const atLeast = (grade: AaaGrade, floor: AaaGrade) => GRADE_ORDER.indexOf(grade) >= GRADE_ORDER.indexOf(floor);

/** The release gate over a set of graded runs. */
export function releaseGate(reports: readonly AaaPromptReport[]): AaaGate {
  const counted = reports.filter((r) => r.versionMatches);
  const distinct = new Set(counted.map((r) => r.promptId));
  const below = counted.filter((r) => !atLeast(r.grade, RELEASE_GATE.minGrade));
  const lines = [
    `${distinct.size} of ${RELEASE_GATE.minPrompts} different prompts graded on their current brief`,
    ...below.map((r) => `${r.promptId}: ${r.grade}, below ${RELEASE_GATE.minGrade}`),
    ...reports
      .filter((r) => !r.versionMatches)
      .map((r) => `${r.promptId}: brief differs from the suite's; not counted`),
  ];
  return { pass: distinct.size >= RELEASE_GATE.minPrompts && below.length === 0, counted: [...distinct], lines };
}

/** Assemble the report. */
export function buildReport(prompts: AaaPromptReport[], tasteMode: string, now: Date): AaaReport {
  return {
    schema: AAA_REPORT_SCHEMA,
    generatedAt: now.toISOString(),
    tasteMode,
    prompts,
    gate: releaseGate(prompts),
  };
}

const MARK: Readonly<Record<CheckResult, string>> = {
  [CheckResult.Pass]: "pass",
  [CheckResult.Fail]: "**fail**",
  [CheckResult.Unknown]: "unmeasured",
};

function checkRows(checks: readonly FloorCheck[]): string[] {
  return [
    "| Floor | Needed for | Result | Evidence |",
    "| --- | --- | --- | --- |",
    ...checks.map(
      (c) => `| ${c.floor} | ${c.tier} | ${MARK[c.result]} | ${c.detail.join("; ").replaceAll("|", "\\|") || "—"} |`,
    ),
  ];
}

function promptSection(r: AaaPromptReport): string[] {
  const subject = [r.subject.game, r.subject.runId, r.subject.head?.slice(0, 8)].filter(Boolean).join(" · ");
  const blockers = r.blockers.map((c) => `\`${c.floor}\` (${MARK[c.result]})`).join(", ") || "none";
  return [
    `## ${r.promptId}: ${r.grade}`,
    "",
    `${r.label}. Subject: ${subject}. Brief matches the suite: ${r.versionMatches ? "yes" : "no"}.`,
    `Reconstructed facts: ${r.reconstructedFacts} (they can fail a floor, never pass one).`,
    `Taste: ${r.taste ? r.taste.grade : `unmeasured (${r.tasteMissing.join("; ")})`}.`,
    `Blocks the next grade: ${blockers}.`,
    "",
    ...checkRows(r.checks),
    "",
  ];
}

/** The report as Markdown, for the evidence folder. */
export function renderReportMarkdown(report: AaaReport): string {
  const table = report.prompts.map((r) => `| ${r.promptId} | ${r.grade} | ${r.blockers.length} |`);
  return [
    "# AA+ release-gate report",
    "",
    `Generated ${report.generatedAt}; taste judge: ${report.tasteMode}.`,
    "",
    `**Release gate: ${report.gate.pass ? "PASS" : "FAIL"}.** ${report.gate.lines.join("; ")}.`,
    "",
    "| Prompt | Grade | Blockers to next grade |",
    "| --- | --- | --- |",
    ...table,
    "",
    ...report.prompts.flatMap(promptSection),
  ].join("\n");
}
