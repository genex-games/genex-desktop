/**
 * Side by side against a baseline run of the same prompt: how each check moved, the measured
 * numbers next to each other, and (when the judge runs) a blind pairwise look comparison per view
 * against the references, in both orders. A candidate is clearly better when its grade is higher,
 * or when it keeps the grade with no check regressed and at least `CLEARLY_BETTER_MIN_IMPROVED`
 * improved; a pairwise judge that prefers the baseline on any view withholds "clearly better".
 * Works for any prompt: views are matched by role, never by camera name.
 */
import fs from "node:fs";
import path from "node:path";
import { sha256Text } from "../ledger/hash.ts";
import { CheckResult } from "../vocabulary.ts";
import type { AaaCapture, AaaEvidence, AaaSubject } from "./evidence.ts";
import { PropOrigin } from "./evidence.ts";
import type { AaaPromptReport } from "./report.ts";
import { CLOSE_PROP_M, type FloorCheck, GRADE_ORDER, LUMA_BANDS, NEAR_SURFACE_M } from "./rubric.ts";
import { comfortMetrics, exposureMetrics } from "./signals.ts";
import type { AaaPrompt, AaaView } from "./suite.ts";
import { imageFromFile, type TasteDeps } from "./taste.ts";

/** The schema tag a comparison carries. */
export const AAA_COMPARE_SCHEMA = "genex-aaa-compare/1";
/** The pairwise taste rubric. */
export const PAIRWISE_TASTE_PROMPT_FILE = path.join(import.meta.dirname, "pairwise-taste-prompt.md");
/** Improved checks a same-grade candidate needs, with none regressed, to be clearly better. */
export const CLEARLY_BETTER_MIN_IMPROVED = 3;

/** The comparison's answer. */
export const CompareVerdict = {
  ClearlyBetter: "clearly-better",
  NotClearlyBetter: "not-clearly-better",
  Worse: "worse",
} as const;
export type CompareVerdict = (typeof CompareVerdict)[keyof typeof CompareVerdict];

/** How one check moved from baseline to candidate. */
export const CheckMove = {
  Improved: "improved",
  Regressed: "regressed",
  Same: "same",
} as const;
export type CheckMove = (typeof CheckMove)[keyof typeof CheckMove];

/** Which side a pairwise look judgement preferred. */
export const PairwiseSide = {
  Candidate: "candidate",
  Baseline: "baseline",
  Same: "same",
  /** The two orders, or the families, disagreed. */
  Split: "split",
} as const;
export type PairwiseSide = (typeof PairwiseSide)[keyof typeof PairwiseSide];

/** One check, before and after. */
export interface CheckDelta {
  floor: string;
  tier: string;
  baseline: CheckResult;
  candidate: CheckResult;
  move: CheckMove;
}

/** One measured number, before and after; `better` is null when either side is unmeasured. */
export interface MetricDelta {
  metric: string;
  baseline: number | null;
  candidate: number | null;
  better: boolean | null;
}

/** One view role's pair of captures and the pairwise verdict on them. */
export interface ViewPair {
  role: string;
  baseline: string | null;
  candidate: string | null;
  taste: PairwiseSide | null;
  detail: string[];
}

/** A whole comparison. */
export interface AaaComparison {
  schema: typeof AAA_COMPARE_SCHEMA;
  promptId: string;
  baseline: { subject: AaaSubject; grade: string };
  candidate: { subject: AaaSubject; grade: string };
  checks: CheckDelta[];
  metrics: MetricDelta[];
  views: ViewPair[];
  verdict: CompareVerdict;
  reasons: string[];
}

const RESULT_RANK: Readonly<Record<CheckResult, number>> = {
  [CheckResult.Fail]: 0,
  /** Unmeasured is not better than failing: a newly measured failure is not a regression. */
  [CheckResult.Unknown]: 0,
  [CheckResult.Pass]: 1,
};

function moveOf(diff: number): CheckMove {
  if (diff > 0) return CheckMove.Improved;
  return diff < 0 ? CheckMove.Regressed : CheckMove.Same;
}

/** Each check of the candidate beside the same check (floor and tier) of the baseline. */
export function checkDeltas(baseline: readonly FloorCheck[], candidate: readonly FloorCheck[]): CheckDelta[] {
  return candidate.flatMap((c) => {
    const b = baseline.find((check) => check.floor === c.floor && check.tier === c.tier);
    if (!b) return [];
    const move = moveOf(RESULT_RANK[c.result] - RESULT_RANK[b.result]);
    return [{ floor: c.floor, tier: c.tier, baseline: b.result, candidate: c.result, move }];
  });
}

/** A number per side and which way is better. */
function metric(name: string, lowerIsBetter: boolean, read: (e: AaaEvidence) => number | null) {
  return (b: AaaEvidence, c: AaaEvidence): MetricDelta => {
    const baseline = read(b);
    const candidate = read(c);
    if (baseline === null || candidate === null) return { metric: name, baseline, candidate, better: null };
    const better = lowerIsBetter ? candidate < baseline : candidate > baseline;
    return { metric: name, baseline, candidate, better };
  };
}

const roleCaptures = (e: AaaEvidence, role: string) => e.captures.filter((c) => c.role === role);
const minOrNull = (values: number[]) => (values.length ? Math.min(...values) : null);
const maxOrNull = (values: number[]) => (values.length ? Math.max(...values) : null);

function lumaOffBand(prompt: AaaPrompt, view: AaaView) {
  const band = LUMA_BANDS[prompt.look][view.setting];
  const off = (c: AaaCapture) => Math.max(0, band.min - c.meanLuma, c.meanLuma - band.max);
  return (e: AaaEvidence) => minOrNull(roleCaptures(e, view.role).map(off));
}

function viewMetrics(prompt: AaaPrompt) {
  return prompt.views.flatMap((view) => [
    metric(`largest capture megapixels: ${view.role}`, false, (e) =>
      maxOrNull(roleCaptures(e, view.role).map((c) => Math.round((c.width * c.height) / 1e4) / 100)),
    ),
    metric(`luma distance outside band: ${view.role}`, true, lumaOffBand(prompt, view)),
  ]);
}

function motionMetrics(prompt: AaaPrompt) {
  return prompt.motion.flatMap(({ demo }) => {
    const read = (key: "bobPeakToPeakM" | "rollAmplitudeDeg" | "maxAbsRollDeg") => (e: AaaEvidence) => {
      const track = e.motion.find((t) => t.demo === demo && !t.reducedMotion);
      return track ? comfortMetrics(track.ticks)[key] : null;
    };
    return [
      metric(`${demo} bob peak to peak (m)`, true, read("bobPeakToPeakM")),
      metric(`${demo} roll amplitude (deg)`, true, read("rollAmplitudeDeg")),
      metric(`${demo} largest roll (deg)`, true, read("maxAbsRollDeg")),
    ];
  });
}

function doorwayMetrics(prompt: AaaPrompt) {
  return prompt.transitions.map(({ demo }) =>
    metric(`${demo} EV change per 0.5 s`, true, (e) => {
      const track = e.exposure.find((t) => t.demo === demo);
      return track ? exposureMetrics(track).maxEvStepPerWindow : null;
    }),
  );
}

const near = (e: AaaEvidence) => (e.surfaces ?? []).filter((s) => s.nearestM <= NEAR_SURFACE_M);
const countOrNull = <T>(list: T[] | null, keep: (item: T) => boolean) =>
  list === null ? null : list.filter(keep).length;

const CONTENT_METRICS = [
  metric("lowest near texel density (px/m)", false, (e) =>
    minOrNull(near(e).flatMap((s) => (s.texelDensityPxPerM === null ? [] : [s.texelDensityPxPerM]))),
  ),
  metric("near surfaces missing normal or ORM", true, (e) =>
    e.surfaces === null ? null : near(e).filter((s) => s.hasNormal === false || s.hasOrm === false).length,
  ),
  metric("primitive props close up or organic", true, (e) =>
    countOrNull(e.props, (p) => p.origin === PropOrigin.Primitive && (p.organic || p.nearestM <= CLOSE_PROP_M)),
  ),
  metric("organic props without cards", true, (e) => countOrNull(e.props, (p) => p.organic && p.hasCards === false)),
  metric("flat-material screen share", true, (e) => e.flatCoverage?.value ?? null),
];

/** Every measured number of both runs, side by side. */
export function metricDeltas(prompt: AaaPrompt, baseline: AaaEvidence, candidate: AaaEvidence): MetricDelta[] {
  const all = [...viewMetrics(prompt), ...motionMetrics(prompt), ...doorwayMetrics(prompt), ...CONTENT_METRICS];
  return all.map((m) => m(baseline, candidate));
}

/** The capture a view is compared on: clean first, then the largest. */
export function pairCapture(evidence: AaaEvidence, role: string): AaaCapture | null {
  const score = (c: AaaCapture) => (c.clean === true ? 1e9 : 0) + c.width * c.height;
  const list = roleCaptures(evidence, role).filter((c) => c.image !== null);
  return list.sort((a, b) => score(b) - score(a))[0] ?? null;
}

/** The answers the pairwise judge gives, in its wire spelling. */
export const Closer = {
  Left: "LEFT",
  Right: "RIGHT",
  Same: "SAME",
} as const;
export type Closer = (typeof Closer)[keyof typeof Closer];

const CLOSER_LINE = /^CLOSER:\s*([A-Z]+)\s*$/;

/** The side a reply's last line names, or null for a reply that does not end in one. */
export function parseCloser(text: string): Closer | null {
  const side = CLOSER_LINE.exec(text.trim().split("\n").at(-1) ?? "")?.[1];
  return Object.values(Closer).find((value) => value === side) ?? null;
}

/** The pairwise template and its sha. */
export function readPairwiseTasteTemplate(): { template: string; sha: string } {
  const template = fs.readFileSync(PAIRWISE_TASTE_PROMPT_FILE, "utf8");
  return { template, sha: sha256Text(template) };
}

/** Both sides' bundles and evidence. */
export interface ComparedRun {
  dir: string;
  evidence: AaaEvidence;
  report: AaaPromptReport;
}

/** What an answer means for the candidate, given which side it was shown on. */
function sideOf(answer: Closer, candidateOn: Closer): PairwiseSide {
  if (answer === Closer.Same) return PairwiseSide.Same;
  return answer === candidateOn ? PairwiseSide.Candidate : PairwiseSide.Baseline;
}

type Image = NonNullable<ReturnType<typeof imageFromFile>>;

/** One family's verdict over both orders: a side only when the orders agree. */
async function familySide(
  pin: TasteDeps["pins"][number],
  text: string,
  refs: Image[],
  cand: Image,
  base: Image,
  deps: TasteDeps,
): Promise<PairwiseSide | null> {
  const ask = async (left: Image, right: Image) => {
    const images = [...refs, { ...left, label: "FRAME LEFT" }, { ...right, label: "FRAME RIGHT" }];
    const reply = await deps.complete(pin, { text, images }).catch(() => null);
    return reply ? parseCloser(reply.text) : null;
  };
  const first = await ask(cand, base);
  const second = await ask(base, cand);
  if (first === null || second === null) return null;
  const a = sideOf(first, Closer.Left);
  return a === sideOf(second, Closer.Right) ? a : PairwiseSide.Split;
}

/** Judge one view in both orders for every family; families must agree, else the view is split. */
async function pairView(
  prompt: AaaPrompt,
  view: AaaView,
  base: ComparedRun,
  cand: ComparedRun,
  template: string,
  deps: TasteDeps,
): Promise<ViewPair> {
  const b = pairCapture(base.evidence, view.role);
  const c = pairCapture(cand.evidence, view.role);
  const pair: ViewPair = {
    role: view.role,
    baseline: b?.image ?? null,
    candidate: c?.image ?? null,
    taste: null,
    detail: [],
  };
  const bImage = b?.image ? imageFromFile(path.join(base.dir, b.image), "B") : null;
  const cImage = c?.image ? imageFromFile(path.join(cand.dir, c.image), "C") : null;
  const refs = deps.referenceStills(prompt, view.role).map((file, i) => imageFromFile(file, `REFERENCE ${i + 1}`));
  const references = refs.filter((image) => image !== null);
  if (!bImage || !cImage || !references.length) return { ...pair, detail: ["a side or the references are missing"] };
  const text = template.replace("{{view}}", view.describe);
  const sides = await Promise.all(deps.pins.map((pin) => familySide(pin, text, references, cImage, bImage, deps)));
  const detail = deps.pins.map((pin, i) => `${pin.family} ${sides[i] ?? "invalid"}`);
  if (sides.some((side) => side === null)) return { ...pair, detail };
  const [first] = sides;
  return { ...pair, taste: sides.every((side) => side === first) ? (first ?? null) : PairwiseSide.Split, detail };
}

/** Pair every view of the prompt; with no judge, each view lists its captures only. */
export async function pairViews(
  prompt: AaaPrompt,
  base: ComparedRun,
  cand: ComparedRun,
  judge: { template: string; deps: TasteDeps } | null,
): Promise<ViewPair[]> {
  const pairs: ViewPair[] = [];
  for (const view of prompt.views) {
    if (judge) pairs.push(await pairView(prompt, view, base, cand, judge.template, judge.deps));
    else {
      const b = pairCapture(base.evidence, view.role)?.image ?? null;
      const c = pairCapture(cand.evidence, view.role)?.image ?? null;
      pairs.push({ role: view.role, baseline: b, candidate: c, taste: null, detail: [] });
    }
  }
  return pairs;
}

const gradeRank = (grade: string) => (GRADE_ORDER as readonly string[]).indexOf(grade);

/** The verdict and the reasons that decided it. */
export function compareVerdict(
  baselineGrade: string,
  candidateGrade: string,
  checks: readonly CheckDelta[],
  views: readonly ViewPair[],
): { verdict: CompareVerdict; reasons: string[] } {
  const improved = checks.filter((c) => c.move === CheckMove.Improved).length;
  const regressed = checks.filter((c) => c.move === CheckMove.Regressed).length;
  const wins = views.filter((v) => v.taste === PairwiseSide.Candidate).length;
  const losses = views.filter((v) => v.taste === PairwiseSide.Baseline).length;
  const judged = views.filter((v) => v.taste !== null).length;
  const reasons = [
    `grade ${baselineGrade} → ${candidateGrade}`,
    `${improved} checks improved, ${regressed} regressed`,
    judged
      ? `look judge: candidate closer on ${wins} of ${views.length} views, baseline on ${losses}`
      : "look judge off",
  ];
  const step = gradeRank(candidateGrade) - gradeRank(baselineGrade);
  if (step < 0 || losses > wins || (step === 0 && regressed > improved))
    return { verdict: CompareVerdict.Worse, reasons };
  const checksClear = step > 0 || (regressed === 0 && improved >= CLEARLY_BETTER_MIN_IMPROVED);
  const verdict = checksClear && losses === 0 ? CompareVerdict.ClearlyBetter : CompareVerdict.NotClearlyBetter;
  return { verdict, reasons };
}

/** Compare a candidate run with a baseline run of the same prompt. */
export async function compareRuns(
  prompt: AaaPrompt,
  base: ComparedRun,
  cand: ComparedRun,
  judge: { template: string; deps: TasteDeps } | null,
): Promise<AaaComparison> {
  const checks = checkDeltas(base.report.checks, cand.report.checks);
  const views = await pairViews(prompt, base, cand, judge);
  const { verdict, reasons } = compareVerdict(base.report.grade, cand.report.grade, checks, views);
  return {
    schema: AAA_COMPARE_SCHEMA,
    promptId: prompt.id,
    baseline: { subject: base.evidence.subject, grade: base.report.grade },
    candidate: { subject: cand.evidence.subject, grade: cand.report.grade },
    checks,
    metrics: metricDeltas(prompt, base.evidence, cand.evidence),
    views,
    verdict,
    reasons,
  };
}

const show = (value: number | null) => (value === null ? "—" : String(Math.round(value * 1000) / 1000));
function betterMark(better: boolean | null): string {
  if (better === null) return "";
  return better ? "better" : "not better";
}

/** The comparison as Markdown; `imageLink` turns a side's capture into a path relative to the page. */
export function renderComparisonMarkdown(
  comparison: AaaComparison,
  imageLink: (side: "baseline" | "candidate", image: string) => string,
): string {
  const label = (s: AaaSubject) => [s.game, s.runId, s.head?.slice(0, 8)].filter(Boolean).join(" · ");
  const moved = comparison.checks.filter((c) => c.move !== CheckMove.Same);
  const viewRows = comparison.views.flatMap((v) => [
    `### ${v.role}${v.taste ? `: ${v.taste} closer` : ""}`,
    "",
    `| baseline | candidate |`,
    `| --- | --- |`,
    `| ${v.baseline ? `![baseline](${imageLink("baseline", v.baseline)})` : "no capture"} | ${v.candidate ? `![candidate](${imageLink("candidate", v.candidate)})` : "no capture"} |`,
    ...(v.detail.length ? ["", v.detail.join("; ")] : []),
    "",
  ]);
  return [
    `# ${comparison.promptId}: candidate vs baseline`,
    "",
    `**${comparison.verdict}.** ${comparison.reasons.join("; ")}.`,
    "",
    `Baseline ${label(comparison.baseline.subject)} (${comparison.baseline.grade}); candidate ${label(comparison.candidate.subject)} (${comparison.candidate.grade}).`,
    "",
    "## Checks that moved",
    "",
    "| Floor | Needed for | Baseline | Candidate | Move |",
    "| --- | --- | --- | --- | --- |",
    ...moved.map((c) => `| ${c.floor} | ${c.tier} | ${c.baseline} | ${c.candidate} | ${c.move} |`),
    ...(moved.length ? [] : ["| — | | | | |"]),
    "",
    "## Measured",
    "",
    "| Metric | Baseline | Candidate | |",
    "| --- | --- | --- | --- |",
    ...comparison.metrics.map(
      (m) => `| ${m.metric} | ${show(m.baseline)} | ${show(m.candidate)} | ${betterMark(m.better)} |`,
    ),
    "",
    "## Views",
    "",
    ...viewRows,
  ].join("\n");
}
