/**
 * The vision judges for honest grading: one pass/fail item for anatomy and pose (every character
 * close-up of the fixed capture set, `anatomy-prompt.md`) and one for place coherence (the top-down
 * map beside the suite's eye-level views, `place-prompt.md`). They speak through the taste judge's
 * model seam and pins. A family passes a capture when most of its votes pass (a tie fails); a
 * capture passes when every family passes it; an item passes when every capture does. A missing
 * capture leaves the item unmeasured.
 */
import fs from "node:fs";
import path from "node:path";
import type { MessageImage } from "../../../src/shared/event-log.ts";
import type { GraderPin } from "../grade/types.ts";
import { sha256Text } from "../ledger/hash.ts";
import type { AaaCapture, AaaEvidence } from "./evidence.ts";
import { closeupRole, type ItemVerdict, MAP_ROLE, type VisionSummary } from "./honest.ts";
import { CLEAN_MIN_SIZE } from "./rubric.ts";
import type { AaaPrompt } from "./suite.ts";
import { imageFromFile, type TasteDeps } from "./taste.ts";

/** The two rubrics the vision judges read. */
export const ANATOMY_PROMPT_FILE = path.join(import.meta.dirname, "anatomy-prompt.md");
export const PLACE_PROMPT_FILE = path.join(import.meta.dirname, "place-prompt.md");

const VERDICT_LINE = /^VERDICT:\s*(pass|fail)\s*$/m;

/** A vision rubric and its sha. */
export function readVisionTemplate(file: string): { template: string; sha: string } {
  const template = fs.readFileSync(file, "utf8");
  return { template, sha: sha256Text(template) };
}

/** The verdict on a reply's last line, or null for a reply that does not end in one. */
export function parseVerdict(text: string): boolean | null {
  const verdict = VERDICT_LINE.exec(text.trim().split("\n").at(-1) ?? "")?.[1];
  return verdict === undefined ? null : verdict === "pass";
}

/** What an item judge returns: its verdict or why there is none. */
export interface ItemOutcome {
  verdict: ItemVerdict | null;
  missing: string[];
}

type CaptureOutcome = { pass: boolean; line: string } | { missing: string };

const judgeable = (c: AaaCapture) =>
  c.clean === true && c.image !== null && c.width >= CLEAN_MIN_SIZE.width && c.height >= CLEAN_MIN_SIZE.height;
const bestCapture = (evidence: AaaEvidence, role: string) =>
  evidence.captures
    .filter((c) => c.role === role && judgeable(c))
    .sort((a, b) => b.width * b.height - a.width * a.height)[0] ?? null;

async function familyPasses(pin: GraderPin, text: string, images: MessageImage[], deps: TasteDeps) {
  let pass = 0;
  let fail = 0;
  for (let vote = 0; vote < deps.votes; vote++) {
    const reply = await deps.complete(pin, { text, images }).catch(() => null);
    const verdict = reply ? parseVerdict(reply.text) : null;
    if (verdict === true) pass++;
    if (verdict === false) fail++;
  }
  return pass + fail === 0 ? null : pass > fail;
}

async function judgeImages(
  label: string,
  text: string,
  images: MessageImage[],
  deps: TasteDeps,
): Promise<CaptureOutcome> {
  const verdicts = await Promise.all(deps.pins.map((pin) => familyPasses(pin, text, images, deps)));
  if (verdicts.includes(null)) return { missing: `${label}: a family gave no valid verdict` };
  const votes = deps.pins.map((pin, i) => `${pin.family} ${verdicts[i] ? "pass" : "fail"}`).join(", ");
  return { pass: verdicts.every(Boolean), line: `${label}: ${votes}` };
}

function summarise(outcomes: CaptureOutcome[], deps: TasteDeps): ItemOutcome {
  const missing = outcomes.flatMap((o) => ("missing" in o ? [o.missing] : []));
  if (missing.length) return { verdict: null, missing };
  const judged = outcomes.flatMap((o) => ("pass" in o ? [o] : []));
  const sameFamily = deps.pins.some((pin) => pin.family === deps.builderFamily);
  return { verdict: { pass: judged.every((o) => o.pass), sameFamily, detail: judged.map((o) => o.line) }, missing };
}

/** Every character close-up of the fixed set, judged for anatomy and pose. */
export async function judgeAnatomy(
  evidence: AaaEvidence,
  bundleDir: string,
  template: string,
  deps: TasteDeps,
): Promise<ItemOutcome> {
  const clips = evidence.characters?.clips ?? [];
  if (!clips.length) return { verdict: null, missing: ["no character clips to judge"] };
  const outcomes: CaptureOutcome[] = [];
  for (const clip of clips) {
    const role = closeupRole(clip);
    const capture = bestCapture(evidence, role);
    const image = capture?.image ? imageFromFile(path.join(bundleDir, capture.image), "CLOSE-UP") : null;
    if (!capture || !image) {
      outcomes.push({ missing: `${role}: no clean close-up of at least 1600×900` });
      continue;
    }
    const text = template.replace("{{clip}}", clip.clip).replace("{{size}}", `${capture.width}×${capture.height}`);
    outcomes.push(await judgeImages(role, text, [image], deps));
  }
  return summarise(outcomes, deps);
}

/** The top-down map and the suite's views, judged for a coherent place. */
export async function judgePlace(
  prompt: AaaPrompt,
  evidence: AaaEvidence,
  bundleDir: string,
  template: string,
  deps: TasteDeps,
): Promise<ItemOutcome> {
  const map = bestCapture(evidence, MAP_ROLE);
  const mapImage = map?.image ? imageFromFile(path.join(bundleDir, map.image), "MAP") : null;
  if (!mapImage) return { verdict: null, missing: [`${MAP_ROLE}: no clean map of at least 1600×900`] };
  const views = prompt.views.flatMap((view) => {
    const capture = bestCapture(evidence, view.role);
    const image = capture?.image ? imageFromFile(path.join(bundleDir, capture.image), `VIEW ${view.role}`) : null;
    return image ? [image] : [];
  });
  return summarise([await judgeImages(MAP_ROLE, template, [mapImage, ...views], deps)], deps);
}

/** Both vision items for a run. */
export async function judgeVision(
  prompt: AaaPrompt,
  evidence: AaaEvidence,
  bundleDir: string,
  deps: TasteDeps,
): Promise<{ summary: VisionSummary; missing: string[] }> {
  const anatomy = await judgeAnatomy(evidence, bundleDir, readVisionTemplate(ANATOMY_PROMPT_FILE).template, deps);
  const place = await judgePlace(prompt, evidence, bundleDir, readVisionTemplate(PLACE_PROMPT_FILE).template, deps);
  return {
    summary: { anatomy: anatomy.verdict, place: place.verdict },
    missing: [...anatomy.missing, ...place.missing],
  };
}
