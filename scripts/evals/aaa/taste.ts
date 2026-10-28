/**
 * The blind taste judge: one clean capture per view, at least 1600×900, set beside the prompt's CC0
 * reference stills and graded on four anchored tiers (`taste-prompt.md`). It speaks through the
 * graders' one model seam (`GraderComplete`), so the families, engines and containment are the
 * checklist grader's; the default family is GPT, a different family from the Claude builder.
 * Families combine by conjunction: a view's tier is the lowest family's, and a prompt's the lowest
 * view's. A view with no judgeable capture leaves the whole verdict unmeasured.
 */
import fs from "node:fs";
import path from "node:path";
import type { MessageImage } from "../../../src/shared/event-log.ts";
import type { GraderComplete } from "../grade/checklist/complete.ts";
import type { GraderPin } from "../grade/types.ts";
import { sha256Text } from "../ledger/hash.ts";
import type { GraderFamily } from "../vocabulary.ts";
import type { AaaCapture, AaaEvidence } from "./evidence.ts";
import { AaaGrade, CLEAN_MIN_SIZE, GRADE_ORDER, type TasteSummary } from "./rubric.ts";
import type { AaaPrompt, AaaView } from "./suite.ts";

/** The taste rubric the judge reads. */
export const TASTE_PROMPT_FILE = path.join(import.meta.dirname, "taste-prompt.md");
/** Votes each family casts per view; the median vote is the family's tier. */
export const DEFAULT_TASTE_VOTES = 3;

const TIER_LINE = /^TIER:\s*(below-aa|aa|aa-plus|aaa-ish)\s*$/m;
const MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

/** The taste template and its sha (a grader pin's `promptSha`). */
export function readTasteTemplate(): { template: string; sha: string } {
  const template = fs.readFileSync(TASTE_PROMPT_FILE, "utf8");
  return { template, sha: sha256Text(template) };
}

/** The template with the view and capture size filled in. */
export function renderTastePrompt(template: string, view: AaaView, capture: AaaCapture): string {
  return template.replace("{{size}}", `${capture.width}×${capture.height}`).replace("{{view}}", view.describe);
}

/** The tier on a reply's `TIER:` line, or null for a reply that does not end in one. */
export function parseTier(text: string): AaaGrade | null {
  const tier = TIER_LINE.exec(text.trim().split("\n").at(-1) ?? "")?.[1];
  return GRADE_ORDER.find((grade) => grade === tier) ?? null;
}

/** An image file as a message image, or null when its type is not one the judge takes. */
export function imageFromFile(file: string, label: string): MessageImage | null {
  const mimeType = MIME_BY_EXT[path.extname(file).toLowerCase()];
  if (!mimeType || !fs.existsSync(file)) return null;
  return { mimeType, data: fs.readFileSync(file).toString("base64"), label };
}

/** What the taste judge needs from its caller. */
export interface TasteDeps {
  pins: GraderPin[];
  complete: GraderComplete;
  votes: number;
  /** The family that built the game, to mark same-family verdicts; null when unknown. */
  builderFamily: GraderFamily | null;
  /** The reference stills (files) for a prompt's view role. */
  referenceStills: (prompt: AaaPrompt, role: string) => string[];
}

/** The judge's verdict, or why there is none. */
export interface TasteOutcome {
  summary: TasteSummary | null;
  /** Why the verdict is unmeasured; empty when there is one. */
  missing: string[];
}

const lowest = (grades: readonly AaaGrade[]) =>
  grades.reduce((low, g) => (GRADE_ORDER.indexOf(g) < GRADE_ORDER.indexOf(low) ? g : low), AaaGrade.AaaIsh);
const median = (grades: readonly AaaGrade[]) =>
  [...grades].sort((a, b) => GRADE_ORDER.indexOf(a) - GRADE_ORDER.indexOf(b))[Math.floor((grades.length - 1) / 2)];

/** The view's judgeable capture: clean, large enough, with its image kept. */
export function tasteCapture(evidence: AaaEvidence, view: AaaView): AaaCapture | null {
  const fits = (c: AaaCapture) =>
    c.role === view.role &&
    c.clean === true &&
    c.image !== null &&
    c.width >= CLEAN_MIN_SIZE.width &&
    c.height >= CLEAN_MIN_SIZE.height;
  return evidence.captures.filter(fits).sort((a, b) => b.width * b.height - a.width * a.height)[0] ?? null;
}

async function familyTier(pin: GraderPin, text: string, images: MessageImage[], deps: TasteDeps) {
  const tiers: AaaGrade[] = [];
  for (let vote = 0; vote < deps.votes; vote++) {
    const reply = await deps.complete(pin, { text, images }).catch(() => null);
    const tier = reply ? parseTier(reply.text) : null;
    if (tier) tiers.push(tier);
  }
  return tiers.length ? (median(tiers) ?? null) : null;
}

/** One view's verdict: its tier and detail line, or why it has none. */
type ViewVerdict = { tier: AaaGrade; line: string } | { missing: string };

async function judgeView(
  prompt: AaaPrompt,
  view: AaaView,
  evidence: AaaEvidence,
  bundleDir: string,
  template: string,
  deps: TasteDeps,
): Promise<ViewVerdict> {
  const capture = tasteCapture(evidence, view);
  const candidate = capture?.image ? imageFromFile(path.join(bundleDir, capture.image), "CANDIDATE") : null;
  if (!capture || !candidate) return { missing: `${view.role}: no clean capture of at least 1600×900` };
  const references = deps
    .referenceStills(prompt, view.role)
    .map((file, i) => imageFromFile(file, `REFERENCE ${i + 1}`))
    .filter((image) => image !== null);
  if (!references.length) return { missing: `${view.role}: no reference stills` };
  const text = renderTastePrompt(template, view, capture);
  const tiers = await Promise.all(deps.pins.map((pin) => familyTier(pin, text, [...references, candidate], deps)));
  const valid = tiers.filter((tier) => tier !== null);
  if (valid.length !== tiers.length) return { missing: `${view.role}: a family gave no valid tier` };
  const votes = deps.pins.map((pin, i) => `${pin.family} ${tiers[i]}`).join(", ");
  return { tier: lowest(valid), line: `${view.role}/${capture.camera}: ${votes}` };
}

/** Judge every view of a prompt; unmeasured when any view has no judgeable capture or no valid vote. */
export async function judgeTaste(
  prompt: AaaPrompt,
  evidence: AaaEvidence,
  bundleDir: string,
  template: string,
  deps: TasteDeps,
): Promise<TasteOutcome> {
  const verdicts: ViewVerdict[] = [];
  for (const view of prompt.views) verdicts.push(await judgeView(prompt, view, evidence, bundleDir, template, deps));
  const missing = verdicts.flatMap((v) => ("missing" in v ? [v.missing] : []));
  if (missing.length) return { summary: null, missing };
  const judged = verdicts.flatMap((v) => ("tier" in v ? [v] : []));
  const sameFamily = deps.pins.some((pin) => pin.family === deps.builderFamily);
  const detail = judged.map((v) => v.line);
  return { summary: { grade: lowest(judged.map((v) => v.tier)), sameFamily, detail }, missing };
}
