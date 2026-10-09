/** Defects a judge names: when two wordings are one complaint, and how the worst become checks (or a routed defect, or a note). */
import { CheckKind, CheckOrigin, CheckWeight, slug, type Check } from "../spec.ts";
import type { AnyRecord } from "../../types/harness.d.ts";
import { FACET_POLICY } from "./policy.ts";
import { CLIP_REASON, sharesStem } from "../text.ts";
import type { FacetPolicy } from "./policy.ts";
import { isUnfilledOpenRung } from "./growth.ts";

/** How much of a defect's words its check id is slugged from. */
const DEFECT_SLUG_CHARS = 40;
/** How much of a defect the vision question that retires it quotes. */
const DEFECT_ASK_CHARS = 280;

/** A check id no check on the spec has yet: the base slugged, then `-2`, `-3`, … */
export function uniqueCheckId(spec: AnyRecord, base: unknown): string {
  const slugged =
    String(base ?? "taste")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, DEFECT_SLUG_CHARS) || "taste";
  let id = slugged;
  for (let n = 2; spec.checks.some((c: AnyRecord) => c.id === id); n++) id = `${slugged}-${n}`;
  return id;
}

/** Nouns-ish tokens of a defect: words ≥ 3 letters (dog, hen, hay, log, fog are nouns here), minus the judge's own vocabulary. */
const DEFECT_STOPWORDS = new Set([
  "the",
  "and",
  "are",
  "its",
  "has",
  "not",
  "but",
  "for",
  "one",
  "two",
  "all",
  "any",
  "out",
  "off",
  "far",
  "few",
  "too",
  "was",
  "can",
  "than",
  "yet",
  "per",
  "via",
  "own",
  "non",
  "set",
  "sit",
  "sits",
  "lie",
  "lies",
  "get",
  "gets",
  "let",
  "may",
  "how",
  "who",
  "why",
  "what",
  "now",
  "our",
  "you",
  "his",
  "her",
  "them",
  "they",
  "see",
  "way",
  "end",
  "top",
  "low",
  "big",
  "that",
  "this",
  "with",
  "from",
  "into",
  "than",
  "then",
  "there",
  "their",
  "which",
  "while",
  "still",
  "only",
  "very",
  "much",
  "more",
  "most",
  "some",
  "same",
  "just",
  "also",
  "when",
  "where",
  "camera",
  "frame",
  "build",
  "shows",
  "show",
  "looks",
  "look",
  "reads",
  "read",
  "seen",
  "sees",
  "visible",
  "defect",
  "should",
  "would",
  "could",
  "does",
  "doesn",
  "have",
  "been",
  "being",
  "over",
  "under",
  "above",
  "below",
  "near",
  "across",
  "along",
  "every",
  "each",
  "both",
  "like",
  "appears",
  "appear",
  "seems",
  "seem",
]);

function defectTokens(text: unknown): Set<string> {
  const out = new Set<string>();
  for (const w of String(text ?? "")
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, " ")
    .split(/[^a-z0-9]+/)) {
    if (w.length >= 3 && !DEFECT_STOPWORDS.has(w)) out.add(w);
  }
  return out;
}

export function defectClass(text: unknown): string | null {
  return /\[([a-z-]+)\]/i.exec(String(text ?? ""))?.[1]?.toLowerCase() ?? null;
}

/**
 * Two wordings of one defect (WP2c): Jaccard over their tokens ≥ 0.5, or the same `[class]`
 * tag with ≥ 3 shared nouns. Exact-string dedupe let "reflection band on the bay" and "the
 * bay's reflection band" grow two checks from one water tint.
 */
export function similarDefect(a: unknown, b: unknown): boolean {
  const ta = defectTokens(a);
  const tb = defectTokens(b);
  if (ta.size === 0 || tb.size === 0) return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
  let shared = 0;
  for (const w of ta) if (tb.has(w)) shared++;
  const union = ta.size + tb.size - shared;
  if (union > 0 && shared / union >= 0.5) return true;
  const ca = defectClass(a);
  return Boolean(ca) && ca === defectClass(b) && shared >= 3;
}

/** The first content words of a defect, in order — the part two wordings of one complaint share. */
function defectOpening(text: unknown, words: number): string[] {
  const out: string[] = [];
  for (const w of String(text ?? "")
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, " ")
    .split(/[^a-z0-9]+/)) {
    if (w.length >= 3 && !DEFECT_STOPWORDS.has(w)) out.push(w);
    if (out.length >= words) break;
  }
  return out;
}

/**
 * The second dedupe net (M3.2). `similarDefect` scores whole texts, so one terse wording and one
 * long one of the same complaint can fall under 0.5 and grow twins — a real run grew
 * `defect-coupe-trunk-deck-reads-as-a-smoot` and `…-smoot-2`, then kept a round because one twin
 * answered "yes" while the other still failed at 0.80. Two questions opening the same way on the
 * same camera are the same question, whatever their tails say.
 */
export function sameDefectOpening(
  a: { camera?: string; defect?: unknown } | null | undefined,
  b: { camera?: string; defect?: unknown } | null | undefined,
  { words = 6, need = 4 }: { words?: number; need?: number } = {},
): boolean {
  if ((a?.camera ?? "default") !== (b?.camera ?? "default")) return false;
  const first = defectOpening(a?.defect, words);
  const second = defectOpening(b?.defect, words);
  if (first.length < need || second.length < need) return false;
  const has = new Set(second);
  let shared = 0;
  for (const w of first) if (has.has(w)) shared++;
  return shared >= need;
}

/** Is a check a judge already grew the same complaint as this candidate? */
export function twinDefect(
  check: AnyRecord | null | undefined,
  candidate: { camera?: string; defect?: unknown },
): boolean {
  if (check?.origin !== CheckOrigin.Judge) return false;
  return sameDefectOpening({ camera: check.camera, defect: check.defect ?? check.ask }, candidate);
}

/** Words that name a reading rather than a sight: no photograph answers them. */
const READOUT_DEFECT = /\b(?:probe|readout|reports?|reporting|state|console|logs?|logged|fps|framerate)\b/i;

/**
 * The probe expression that would have measured a defect the camera cannot see. "the live probe
 * reports speedKept 0.069 while the HUD shows 4 km/h" names a number in the game's own state,
 * and the check that catches it is arithmetic, not a crop. Returns null when the text names no
 * path — then the ledger keeps the sentence and nothing pretends to measure it.
 */
export function suggestedProbe(text: unknown): string | null {
  const source = String(text ?? "");
  const dotted = [...source.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\b/g)]
    .map((m) => m[1])
    .find((p) => !/\.(?:js|mjs|ts|jsx|tsx|json|md|html|css)$/i.test(p));
  // A bare name is worth probing only when it is written like a field and not like a word:
  // `speedKept` and `frame_time` are state, "a shader warning" is prose.
  const named = dotted ?? /\b([a-z_$][\w$]*(?:[A-Z]|_)[\w$]*)\b/.exec(source)?.[1] ?? null;
  if (!named) return null;
  const path = /^(?:state|early)\./.test(named) ? named : `state.${named}`;
  // The number the judge read is the bar the fix has to clear; without one, "the game reports it
  // at all" is the honest check. A bare name keeps its guessed parent — the builder owns the tree.
  const observed =
    new RegExp(
      `${named.replace(/[.$]/g, "\\$&")}\\s*(?:is|=|of|at|:|reads|reports?)?\\s*(-?\\d+(?:\\.\\d+)?)`,
      "i",
    ).exec(source)?.[1] ?? null;
  return observed === null ? `has('${path}')` : `${path} > ${observed}`;
}

/** Words of a text as a facet's vocabulary holds them: lower-case, three letters or more. */
function vocabularyWords(text: unknown): string[] {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
}

/** A file's name without its folder or extension: `src/village/fabric.js` → `fabric`. */
function fileStem(file: unknown): string | undefined {
  return String(file)
    .split("/")
    .pop()
    ?.replace(/\.[^.]+$/, "");
}

/** Each rung's words, but an open rung nobody has filled: it says the same on every ladder, so its words are no part's own. */
function ladderWords(spec: AnyRecord | null | undefined): unknown[] {
  return (spec?.milestones ?? []).filter((m: AnyRecord) => !isUnfilledOpenRung(m)).map((m: AnyRecord) => m?.what);
}

/** The words a facet is known by: its id, title, identity, owned file names, cameras, intent, ladder and plan-written checks. */
function facetVocabulary(spec: AnyRecord | null | undefined): Set<string> {
  const texts: unknown[] = [spec?.id, spec?.title, ...(spec?.identity ?? [])];
  for (const own of spec?.owns ?? []) texts.push(fileStem(own));
  texts.push(...(spec?.cameras ?? []));
  // The plan's own words: "chickens peck… the dog trots a loop" is how a dog defect finds the
  // life facet rather than one whose vocabulary is file names and camera names only.
  texts.push(spec?.intent, ...ladderWords(spec));
  for (const check of spec?.checks ?? []) {
    if (check.origin === CheckOrigin.Harness || check.origin === CheckOrigin.Judge) continue;
    for (const m of String(check.js ?? "").matchAll(/\(['"]([a-z0-9-_]+)['"]\)/g)) texts.push(m[1]);
    texts.push(check.id, check.ask, check.note);
  }
  return new Set(texts.flatMap(vocabularyWords));
}

/** How strongly a defect's words match a facet's vocabulary (tags, identity, title, owned file names, camera names). */
export function facetVocabularyScore(spec: AnyRecord | null | undefined, text: unknown): number {
  const words = defectTokens(text);
  if (words.size === 0) return 0;
  const vocab = facetVocabulary(spec);
  let score = 0;
  for (const w of words) {
    if (vocab.has(w)) score += 1;
    else if ([...vocab].some((v) => sharesStem(w, v))) score += 0.5;
  }
  return score;
}

/** How `defectsToChecks` is asked: where the defects were seen, who else could own them, and where a note or a routed check goes. */
interface DefectOptions {
  evidence?: AnyRecord | null;
  iteration?: number;
  facets?: AnyRecord[] | null;
  routeDefect?: ((facetId: string, check: AnyRecord) => unknown) | null;
  noteDefect?: ((note: { text: string; why: string; suggestedProbe: string | null }) => unknown) | null;
  priority?: string | null;
  policy?: FacetPolicy;
}

/** A defect as `defectsToChecks` weighs it: its text, the camera it names (or the default one) and whether it named one. */
interface Candidate {
  text: string;
  camera: string;
  named: boolean;
}

/**
 * The worst few defects a judge named, as vision checks the scoreboard carries from the next
 * iteration on. The camera is the one the defect text names, else the default camera; the
 * question passes once the defect is gone. Dedupe is by meaning (similarDefect) and, where that
 * misses, by the question's opening on the same camera (sameDefectOpening) against the live judge
 * checks and the facet's retired defects; a defect that reads as another facet's (its vocabulary
 * wins by ≥ 2 tokens, WP2d) is routed there through `routeDefect` instead of growing on the facet
 * that happened to be judged. The live count is capped.
 *
 * A defect about a reading rather than a sight never becomes a picture question at all (M3.2):
 * "the live probe reports speedKept 0.069", asked of a JPEG, is answered "no, no readout is
 * visible" every time. Those go to `noteDefect` — the ledger the
 * builder's brief already carries — with the probe expression that would measure them.
 */
export function defectsToChecks(
  spec: AnyRecord & { id: string; checks: AnyRecord[] },
  defects: readonly unknown[] | null | undefined,
  options: DefectOptions = {},
): Check[] {
  const { iteration = 0, noteDefect = null, priority = null, policy = FACET_POLICY } = options;
  const live = spec.checks.filter((c) => c.origin === CheckOrigin.Judge).length;
  let room = Math.max(0, Math.min(policy.defectChecksPerIteration, policy.maxJudgeChecks - live));
  const cameras = namedCameras(spec, options.evidence ?? null);
  const seen: Array<{ camera: string; defect: string }> = [];
  const added: Check[] = [];
  for (const raw of defects ?? []) {
    const candidate = defectCandidate(spec, raw, cameras, seen);
    if (!candidate) continue;
    const { text, camera } = candidate;
    seen.push({ camera, defect: text });
    if (notedAsReading(candidate, noteDefect)) continue;
    if (routedElsewhere(spec, candidate, options)) continue;
    // The judge's biggest gap never waits for room: the trees stood four iterations behind
    // fences and carts on a full board before their check existed.
    const isPriority = Boolean(priority) && similarDefect(priority, text);
    if (room === 0 && !isPriority) continue;
    added.push(defectCheck(spec, spec, candidate, iteration));
    room = Math.max(0, room - 1);
  }
  return added;
}

/**
 * No camera named and the complaint is about a number, a log line or an internal reading: the
 * ledger, not the board. Answers whether the defect went to the ledger.
 */
function notedAsReading(candidate: Candidate, noteDefect: DefectOptions["noteDefect"]): boolean {
  const { text } = candidate;
  if (candidate.named || !READOUT_DEFECT.test(text)) return false;
  if (typeof noteDefect === "function")
    noteDefect({
      text: text.slice(0, CLIP_REASON),
      why: "not visible in a frame",
      suggestedProbe: suggestedProbe(text),
    });
  return true;
}

/** The cameras a defect can name: the spec's, the harness's eyes and the frames that were shot — longest first, so the most specific matches. */
function namedCameras(spec: AnyRecord, evidence: AnyRecord | null): string[] {
  return [
    ...new Set<string>([
      ...(spec.cameras ?? []),
      ...(evidence?.eyes ?? []),
      ...(evidence?.shots ?? []).map((s: AnyRecord) => s.camera),
    ]),
  ]
    .filter((c) => typeof c === "string" && c && c !== "user:view")
    .sort((a, b) => b.length - a.length);
}

/** A defect worth a new question, with its camera — or null when it is empty, retired, blocked, or already asked. */
function defectCandidate(
  spec: AnyRecord & { checks: AnyRecord[] },
  raw: unknown,
  cameras: string[],
  seen: Array<{ camera: string; defect: string }>,
): Candidate | null {
  const text = String(raw ?? "").trim();
  if (!text || seen.some((s) => similarDefect(s.defect, text))) return null;
  if (isRetiredOrBlocked(spec, text)) return null;
  if (spec.checks.some((c) => isGrownFrom(c, text))) return null;
  const lower = text.toLowerCase();
  const named = cameras.find((c) => lower.includes(c.toLowerCase())) ?? null;
  const camera = named ?? "default";
  const question = { camera, defect: text };
  if (seen.some((s) => sameDefectOpening(s, question)) || spec.checks.some((c) => twinDefect(c, question))) return null;
  return { text, camera, named: named !== null };
}

/** A defect the facet has solved before, or a class the builder disowned by flag ("[haze-plane] is lighting's"), never re-grows here. */
function isRetiredOrBlocked(spec: AnyRecord, text: string): boolean {
  if ((spec.retiredDefects ?? []).some((d: unknown) => similarDefect(d, text))) return true;
  const cls = defectClass(text);
  return (spec.blockedDefects ?? []).some((b: AnyRecord) => {
    const sameClass = b.class && cls && b.class === cls;
    return sameClass || (b.text && similarDefect(b.text, text));
  });
}

/** Is this check the judge's own question about the same defect? */
function isGrownFrom(check: AnyRecord, text: string): boolean {
  if (check.origin !== CheckOrigin.Judge) return false;
  return check.defect === text || Boolean(check.defect && similarDefect(check.defect, text));
}

/**
 * Does the defect read as another facet's (its vocabulary wins by ≥ 2 tokens, WP2d)? Then it is
 * routed there — or dropped, when that facet already asks it — instead of growing here. A defect
 * the router would not take stays on this facet.
 */
function routedElsewhere(spec: AnyRecord & { id: string }, candidate: Candidate, options: DefectOptions): boolean {
  const { facets = null, routeDefect = null, iteration = 0 } = options;
  const others = (facets ?? []).filter((f) => f && f.id !== spec.id);
  if (typeof routeDefect !== "function" || !others.length) return false;
  const { text } = candidate;
  const mine = facetVocabularyScore(spec, text);
  const best = others.map((f) => ({ f, score: facetVocabularyScore(f, text) })).sort((a, b) => b.score - a.score)[0];
  if (!best || best.score < mine + 2) return false;
  const already = (best.f.checks ?? []).some(
    (c: AnyRecord) => c.origin === CheckOrigin.Judge && c.defect && similarDefect(c.defect, text),
  );
  if (already) return true;
  return routeDefect(best.f.id, defectCheck(best.f, spec, candidate, iteration)) !== false;
}

/** The vision question that passes once the defect is gone, for the facet that will carry it. */
function defectCheck(
  target: AnyRecord,
  spec: AnyRecord & { id: string },
  candidate: Candidate,
  iteration: number,
): Check {
  const { text, camera } = candidate;
  return {
    id: uniqueCheckId(target, `defect-${slug(text.slice(0, DEFECT_SLUG_CHARS), "defect")}`),
    kind: CheckKind.Vision,
    weight: CheckWeight.Normal,
    hard: false,
    camera,
    ask: `Is this defect gone? "${text.slice(0, DEFECT_ASK_CHARS)}" — answer yes only if the frame no longer shows it.`,
    expect: "yes",
    origin: CheckOrigin.Judge,
    defect: text.slice(0, CLIP_REASON),
    note: `judge defect at iteration ${iteration}${target !== spec ? ` (named while judging ${spec.id}, routed here)` : ""}`,
  };
}
