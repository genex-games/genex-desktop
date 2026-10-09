/**
 * Facet specs — the typed contract a planner emits per facet (HARNESS-REWORK.md §4.1).
 *
 * A spec keeps the prose brief as `intent` and adds what the old brief only implied: which
 * files the facet owns, its ranked identity features, the cameras the judge must look
 * through, and a list of checks the harness (or a one-question judge) can evaluate. The
 * harness validates a spec before a facet starts — unknown kinds, expressions that do not
 * parse, a vision check without a camera — so the planner is asked again instead of a run
 * being spent on a contract nobody can verify.
 *
 * The check catalogue (`library/checks.json`) is the reusable half: checks that earned their
 * keep in past runs, keyed by id, rendered into the planner's prompt so thresholds are reused
 * instead of reinvented. Duplicates are impossible by construction.
 */
import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { dryRunChecks, parseExpr } from "./checks.ts";
import { lintCheck } from "./check-lint.ts";
import { notThisBuildsQuestion } from "./harness-needs.ts";
import { DEFAULT_HUD_BUDGET, hudBudgetFor } from "./hud-budget.ts";
import { criticFor, inputProbesFor, isGameKind, normalizeGameTraits, wantsEyeCameras } from "./kinds.ts";
import { isRecord } from "./json.ts";
import { hasText } from "./text.ts";
import { DEFAULT_CAMERA } from "./cameras.ts";
import { demoOfFrame, isPassFrame } from "./pass-frames.ts";
import { ProbeAfter } from "./throttle-bot.ts";
import { PlayReaches } from "./quest.ts";
// A namespace for what kinds.ts gained later: a seed upgrade keeps a kinds.ts the agent edited, and
// a named import it lacks would stop this file loading.
import * as kinds from "./kinds.ts";
import type { AnyRecord } from "../types/harness.d.ts";

/** The most checks one facet's board carries. */
export const MAX_CHECKS = 16;
/**
 * The most craft recipes a facet may put on its own board. Craft is technique, not law: a
 * planner that wants a recipe's check measured names it here, and everything else in the
 * library is retrieved when a check fails or the judge names the matching defect.
 */
export const MAX_CRAFT = 3;
/** The most `done` entries a contract may carry: more than four is a plan, not a definition of done. */
export const MAX_DONE = 4;
/** The most cameras a facet names for its judge. */
export const MAX_CAMERAS = 8;
/** The ladder of structural steps a facet climbs — one per iteration once identity holds. */
export const MAX_MILESTONES = 6;
/** The longest id a slug makes. */
const MAX_SLUG = 48;
/** A sentence a planner writes — a done line, a milestone, a question — is kept to this. */
const SENTENCE_CHARS = 400;
/** What a check keeps of its note, its origin, its recipe, its camera and its demo. */
const CHECK_NOTE_CHARS = 200;
const CHECK_ORIGIN_CHARS = 20;
const CHECK_RECIPE_CHARS = 64;
const CHECK_CAMERA_CHARS = 40;
const CHECK_DEMO_CHARS = 60;
/** The most state paths a check says it needs (the reason line stays readable). */
const MAX_CHECK_NEEDS = 4;
/** How far a metric may move before the ratchet calls it a change. */
const METRIC_TOLERANCE = 0.02;
/** What a facet keeps of its identity features, its owned files and its title. */
const MAX_IDENTITY = 8;
const MAX_OWNS = 12;
const FACET_TITLE_CHARS = 80;
/** A board this big or bigger may not be mostly vision checks. */
const MIN_BOARD_FOR_VISION_RULE = 4;
/** The critic (judge.ts CRITIC_PRINCIPLES) a UI or HUD part is reviewed by: its board may be mostly vision. */
const SCREEN_CRITIC = "screen";
/** How many of the keys a build reports an unsatisfiable check's note names. */
const STATE_KEYS_NAMED = 8;
/** How many catalogue entries the planner is shown per group, and what an entry keeps of its runs and genres. */
const CATALOGUE_LIMIT = 40;
const MAX_ENTRY_RUNS = 8;
const MAX_ENTRY_GENRES = 6;
/** The most `delta(...)` paths one check says it needs. */
const MAX_DELTA_PATHS = 4;
/** A hand-seeded check the runs never satisfied: after this many uses it stops reaching the planner. */
const STALE_SEED_USES = 3;
/** A check the judge grew reaches the planner once it caught a defect this often, across this many runs. */
const LEARNED_MIN_CATCHES = 2;
const LEARNED_MIN_RUNS = 2;

/** A check as an evaluator reads it: only its id and kind are sure (weight defaults to "normal"). */
export type CheckLike = Pick<Check, "id" | "kind"> & Partial<Check>;

/**
 * One check on a facet's board. `kind` decides which of the kind fields it carries: `js`
 * (scene), `expr` (pixel, probe, metric, demo), `camera`, `name`/`demo`, `ask`/`expect`
 * (vision, play), `goal`/`tol`/`target` (metric).
 */
export interface Check {
  id: string;
  kind: string;
  /** "identity" or "normal": identity checks decide whether the work is done. */
  weight: string;
  hard: boolean;
  note: string;
  /** Who put it on the board: planner, judge, harness, spike, craft, milestone. */
  origin?: string;
  needs?: string[];
  fromRecipe?: string;
  optional?: boolean;
  js?: string;
  camera?: string;
  detail?: string;
  expr?: string;
  goal?: string;
  tol?: number;
  target?: number;
  demo?: string;
  /** A probe that reads the state a run the evidence pass makes itself left (`ProbeAfter`). */
  after?: string;
  name?: string;
  /** [x0, y0, x1, y1] as fractions of the frame. */
  crop?: [number, number, number, number];
  ask?: string;
  expect?: string;
  milestone?: string;
  defect?: string;
  [field: string]: unknown;
}

/** One structural step on a facet's ladder, with the check that measures it when it has one. */
export interface Milestone {
  id: string;
  what: string;
  check?: Check;
  /** The director steered it in mid-run (`worker_steer move=`): it goes ahead of the rest of the ladder. */
  steered?: boolean;
  /** The ladder's open rung (facet/growth.ts): the reviewers' best step inside the ask fills it when it is reached. */
  open?: boolean;
  /** Who filled an open rung (facet/rules.ts `MoveSource`): the reviewer or the critic. */
  filledBy?: string;
  /** Why a filled open rung is the move, as the builder's brief says it. */
  why?: string;
}

/** What "done" means for a facet, one sentence per identity check. */
export interface DoneEntry {
  id: string;
  what: string;
}

/** A facet's contract: its brief, what it owns, its identity, its cameras and its board. */
export interface FacetSpec {
  id: string;
  title: string;
  intent: string;
  brief: string;
  owns: string[];
  identity: string[];
  done?: DoneEntry[];
  cameras: string[];
  checks: Check[];
  craft: string[];
  milestones: Milestone[];
  budgetShare: number;
  /**
   * What already works in the whole game and must stay, as the art director last named it
   * (director/art-direction.ts): the brief shows it, and the taste judge calls losing one a regression.
   */
  doNotRegress?: string[];
  [field: string]: unknown;
}

/** A spec as far as validation reads it. */
export interface SpecToValidate {
  id: string;
  intent?: string;
  checks?: Check[];
  milestones?: Milestone[];
  done?: DoneEntry[];
  [field: string]: unknown;
}

/** One check id in the catalogue, with its body and what the runs made of it. */
export interface CatalogueEntry {
  kind?: string;
  uses?: number;
  passes?: number;
  catches?: number;
  origin?: string;
  runs?: string[];
  genres?: string[];
  kinds?: string[];
  pack?: string;
  note?: string;
  lastUsed?: string;
  [field: string]: unknown;
}

/** `library/checks.json`: the checks that earned their keep, and the ones retired into recipes. */
export interface Catalogue {
  version: number;
  checks: Record<string, CatalogueEntry>;
  retired: Record<string, AnyRecord>;
  /** The file is there but could not be read: saving over it would lose every earlier run's counts. */
  unreadable?: boolean;
}

/** How each check read at the end, by id — enough of a board to count a check's outcomes. */
export type BoardOutcomes = Record<string, { pass?: boolean | null } | undefined>;

// The kind table lives in one module (loop/kinds.ts) so nobody re-decides what a kind is. It
// is re-exported here because the two callers that normalise a plan's game block — autopilot
// and the director — have always imported it from the spec module.
export { normalizeGameTraits };

/** What a check measures, which decides the fields it carries (see `Check`). Plans and boards keep it. */
export const CheckKind = {
  Scene: "scene",
  Pixel: "pixel",
  Metric: "metric",
  Probe: "probe",
  Demo: "demo",
  Vision: "vision",
  Play: "play",
} as const;
export type CheckKind = (typeof CheckKind)[keyof typeof CheckKind];

/** How much a check counts: identity checks decide whether the work is done. */
export const CheckWeight = {
  Identity: "identity",
  Normal: "normal",
} as const;
export type CheckWeight = (typeof CheckWeight)[keyof typeof CheckWeight];

/** Who put a check on the board (`Check.origin`), or grew a catalogue entry (`seed` ships with the harness). */
export const CheckOrigin = {
  Planner: "planner",
  Judge: "judge",
  Harness: "harness",
  Spike: "spike",
  Craft: "craft",
  Milestone: "milestone",
  Seed: "seed",
  /** A director run's lead, whose workers' checks its close keeps in the catalogue. */
  Director: "director",
} as const;
export type CheckOrigin = (typeof CheckOrigin)[keyof typeof CheckOrigin];

/**
 * Who names a worker's next move (`FacetSpec.moveOwner`): the director, once it wrote the ladder.
 * Journals keep it: never rename a value.
 */
export const MoveOwner = {
  Director: "director",
} as const;
export type MoveOwner = (typeof MoveOwner)[keyof typeof MoveOwner];

/** Every check kind, for code that checks one at run time. */
export const CHECK_KINDS: string[] = Object.values(CheckKind);

/**
 * The check grammar, once. It used to exist in three drifted copies — the planner skill's
 * SLOW_UPDATE region, the fallback autopilot uses when an install's skill predates typed specs,
 * and the director's `worker_start` tool schema — and the three had already stopped agreeing
 * about which helpers are in scope and which kinds exist.
 *
 * `shape` is the JSON a planner writes, `says` the clause that fits on the same line, and
 * `more` the lines that only a prompt with room for them wants: a tool schema shipped to every
 * session on every turn takes `helpers: false` and pays for the shape alone.
 */
const CHECK_GRAMMAR: Record<string, { shape: string; says: string; more?: string[] }> = {
  scene: {
    shape: `{"kind":"scene","js":"meshes('terrain').every(m => !m.material.transparent && m.material.depthWrite)"}`,
    says: "JS over the game's scene graph. Objects are found by `obj.userData.tag`; name the tags the builder must use.",
    more: [
      "Helpers in scope: scene, renderer, camera, state, player, objects(tag), meshes(tag),",
      "materials(tag), lights(), tags(), untagged(), count(tag), bbox(tag) → {min,max,size},",
      "bboxOf(obj), renderTargets() → [{width,height}], domUi(), audio() → {rms,centroid}.",
    ],
  },
  pixel: {
    shape: `{"kind":"pixel","camera":"default","expr":"meanLuma in [0.32,0.45] && fractionAbove(0.9) <= 0.02"}`,
    says: "numbers are 0–1: meanLuma, litFraction, saturation, contrast, edgeDensity, top, middle, bottom, left, center, right, fractionAbove(t), fractionBelow(t).",
    more: [
      "Operators: && || ! < <= > >= == != and `x in [a,b]`. A check on what the player sees uses",
      "`eye:spawn` / `eye:here`, not `default`: a wide default camera passed a mid-key band while",
      "every eye-height frame was washed out.",
    ],
  },
  metric: {
    shape: `{"kind":"metric","camera":"camDock","expr":"styleDistance","goal":"min","tol":0.02}`,
    says: "a NUMBER the scoreboard ratchets (better by more than tol is a flip, worse a regression).",
    more: [
      "Over the pixel numbers plus `styleDistance` (0–1 distance to the nearest reference still)",
      'and `styleDistanceTo("<still>")`. With reference stills every facet carries ONE identity',
      "metric `style-distance-<camera>` on its primary camera (the harness adds it if you do not).",
    ],
  },
  probe: {
    shape: `{"kind":"probe","expr":"delta('player.x') != 0 || delta('player.z') != 0","needs":["player.x","player.z"]}`,
    says: "over `__studio.state()` with dotted paths (bare, or under `state.`), early.<path>, delta(path), abs, min, max, len, has; bound how much is drawn only from above.",
    more: [
      "`needs` names up to four dotted paths the check cannot be judged without: a state that",
      "lacks one reports the check unmeasured instead of failing a game that never had it.",
      'Add {"demo":"prop-run"} when the number is one a demo drives: the probe is then read from',
      "the state that demo left behind, and the demo cap can never drop it.",
    ],
  },
  demo: {
    shape: `{"kind":"demo","name":"district-walk"}`,
    says: 'a config.demos entry that runs deterministically to its end state; add "expr" over its result if it returns data.',
  },
  vision: {
    shape: `{"kind":"vision","camera":"camBridge","crop":[0.2,0.55,0.8,1.0],"ask":"Is the bridge's inverted silhouette recognisable in the water?"}`,
    says: 'ONE yes/no question about ONE crop, answered from the pixels; "expect":"no" flips it. Ask what a player can see or read, never the technique that draws it. The minority of any board.',
  },
  play: {
    shape: `{"kind":"play","ask":"Could you find the bench and sit on it?"}`,
    says: "one yes/no question answered by a playtester who plays the build. At most one per facet.",
    more: [
      'Add {"reaches":"setup"} when the question is whether a player reaches the run\'s requested',
      "state: a blind judge then plays to it, and its yes counts only once the studio saw it.",
    ],
  },
};

/** The line the planner skill ships in place of its own copy of the grammar. */
export const CHECK_GRAMMAR_MARKER = "{{check-grammar}}";

/** The header the skill's copy carries, so the marker expands into the bullet it replaced. */
export const CHECK_GRAMMAR_HEADER = "- Check shapes (fields per kind):";

/**
 * The check grammar as text. `kinds` is explicit at every call site — the planner's fallback
 * deliberately omits `metric`, and a kind that silently appeared there would be a kind the
 * planner started writing with no evaluator behind it in that path.
 */
export function renderCheckGrammar({
  kinds = CHECK_KINDS,
  header = "",
  indent = "",
  helpers = true,
}: {
  kinds?: readonly string[] | null;
  header?: string;
  indent?: string;
  helpers?: boolean;
} = {}): string {
  const lines: string[] = [];
  if (header) lines.push(`${indent}${header}`);
  const inner = header ? `${indent}  ` : indent;
  for (const kind of kinds ?? []) {
    const grammar = CHECK_GRAMMAR[kind];
    if (!grammar) continue;
    lines.push(`${inner}- ${kind}: ${grammar.shape} — ${grammar.says}`);
    if (helpers) for (const line of grammar.more ?? []) lines.push(`${inner}  ${line}`);
  }
  return lines.join("\n");
}

/**
 * Expand `{{check-grammar}}` in a skill file that ships it. A workspace whose own copy predates
 * the marker (SkillOpt edited it, and the seed upgrader rightly keeps that copy) carries its own
 * text and comes back unchanged — which is why this is a replace, never an assertion.
 */
export function expandCheckGrammar(text: unknown): string {
  const body = String(text ?? "");
  if (!body.includes(CHECK_GRAMMAR_MARKER)) return body;
  return body.replaceAll(CHECK_GRAMMAR_MARKER, renderCheckGrammar({ header: CHECK_GRAMMAR_HEADER, helpers: true }));
}

/**
 * Normalise one milestone from planner JSON: `{ id, what, check? }`. `what` is the structural
 * change in a sentence (what the game IS afterwards, not how it looks); `check` is optional
 * and, when present, a normal check that joins the board the iteration the milestone is the
 * move. Null for anything that is not a milestone.
 */
export function normalizeMilestone(raw: AnyRecord | null | undefined, index = 0): Milestone | null {
  if (!raw || typeof raw !== "object") return null;
  const what = String(raw.what ?? raw.intent ?? raw.title ?? "")
    .trim()
    .slice(0, SENTENCE_CHARS);
  if (!what) return null;
  const id = slug(raw.id ?? `m${index + 1}-${what}`, `milestone-${index + 1}`);
  const check =
    raw.check && typeof raw.check === "object"
      ? normalizeCheck({ ...raw.check, id: raw.check.id ?? `milestone-${id}`, origin: CheckOrigin.Milestone }, index)
      : null;
  return { id, what, ...(check ? { check: { ...check, milestone: id } } : {}) };
}

export function slug(text: unknown, fallback = "check"): string {
  const s = String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG);
  return s || fallback;
}

/** The fields every check carries, whatever its kind. */
function checkBase(raw: AnyRecord, id: string, kind: string) {
  return {
    id,
    kind,
    weight: raw.weight === CheckWeight.Identity ? CheckWeight.Identity : CheckWeight.Normal,
    hard: raw.hard === true,
    note: typeof raw.note === "string" ? raw.note.slice(0, CHECK_NOTE_CHARS) : "",
    // Who put the check on the board: planner (default), judge (a defect turned into a
    // check), harness (owned by the loop — a builder cannot remove it), spike, craft (a
    // recipe the plan asked for).
    ...(typeof raw.origin === "string" && raw.origin ? { origin: raw.origin.slice(0, CHECK_ORIGIN_CHARS) } : {}),
    // The state paths the check cannot be read without: a build that reports none of them is
    // UNMEASURED, not failed (checks.ts needsNotReported). At most four, so the reason line
    // stays readable.
    ...(Array.isArray(raw.needs) && raw.needs.length
      ? {
          needs: [...new Set(raw.needs.map((p: unknown) => String(p).trim()).filter(Boolean))].slice(
            0,
            MAX_CHECK_NEEDS,
          ) as string[],
        }
      : {}),
    // The library recipe this check came off. It is also what keeps the check out of the
    // catalogue: a recipe owns its own body, and a copy of it must not become a second one.
    ...(typeof raw.fromRecipe === "string" && raw.fromRecipe
      ? { fromRecipe: raw.fromRecipe.slice(0, CHECK_RECIPE_CHARS) }
      : {}),
    // A check the harness may leave unmeasured rather than failing when the thing it names
    // is not there at all — a demo a game never registers is not the same as a demo that ran
    // and went wrong.
    ...(raw.optional === true ? { optional: true } : {}),
  };
}

/** A demo check's expression: the one it was given, else what it expects, else that it runs to its end. */
function demoExpr(raw: AnyRecord): string {
  if (typeof raw.expr === "string" && raw.expr.trim()) return raw.expr.trim();
  if (typeof raw.expect === "string" && raw.expect !== "ok") return raw.expect;
  return "ok";
}

/** A vision check's crop: four fractions of the frame, or null. */
function visionCrop(raw: AnyRecord): [number, number, number, number] | null {
  const fractions =
    Array.isArray(raw.crop) &&
    raw.crop.length === 4 &&
    raw.crop.every((v: unknown) => typeof v === "number" && v >= 0 && v <= 1);
  return fractions ? (raw.crop.map(Number) as [number, number, number, number]) : null;
}

/** A question a vision or play check asks, as one yes/no sentence. */
const askOf = (raw: AnyRecord): string =>
  String(raw.ask ?? raw.question ?? "")
    .trim()
    .slice(0, SENTENCE_CHARS);

/** The fields each kind of check carries beside the base, from what the planner wrote. */
const KIND_FIELDS: Record<CheckKind, (raw: AnyRecord, camera: string) => AnyRecord> = {
  [CheckKind.Scene]: (raw, camera) => ({
    js: String(raw.js ?? "").trim(),
    ...(camera ? { camera } : {}),
    ...(typeof raw.detail === "string" && raw.detail.trim() ? { detail: raw.detail.trim() } : {}),
  }),
  [CheckKind.Pixel]: (raw, camera) => ({ camera: camera || DEFAULT_CAMERA, expr: String(raw.expr ?? "").trim() }),
  // A number the scoreboard ratchets (WP4): `styleDistance` to the nearest still by default.
  [CheckKind.Metric]: (raw, camera) => ({
    camera: camera || DEFAULT_CAMERA,
    expr: String(raw.expr ?? "styleDistance").trim() || "styleDistance",
    goal: raw.goal === "max" ? "max" : "min",
    tol: typeof raw.tol === "number" && raw.tol >= 0 ? raw.tol : METRIC_TOLERANCE,
    ...(typeof raw.target === "number" ? { target: raw.target } : {}),
  }),
  // `demo` scopes the probe to one demo's end state. It used to be dropped here, so a planner
  // asking for a number a demo drives got it read from the pre-demo sample.
  [CheckKind.Probe]: (raw) => {
    const demo = String(raw.demo ?? "")
      .trim()
      .slice(0, CHECK_DEMO_CHARS);
    // `after` reads a run the pass makes itself (the throttle-only bot's race); only its own words.
    const after = (Object.values(ProbeAfter) as unknown[]).includes(raw.after) ? { after: raw.after } : {};
    return { expr: String(raw.expr ?? "").trim(), ...(demo ? { demo } : {}), ...after };
  },
  [CheckKind.Demo]: (raw) => ({
    name: String(raw.name ?? raw.demo ?? "")
      .trim()
      .slice(0, CHECK_DEMO_CHARS),
    expr: demoExpr(raw),
  }),
  [CheckKind.Vision]: (raw, camera) => {
    const crop = visionCrop(raw);
    return {
      camera: camera || DEFAULT_CAMERA,
      ...(crop ? { crop } : {}),
      ask: askOf(raw),
      expect: raw.expect === "no" ? "no" : "yes",
    };
  },
  // `reaches` ties the question to the run's requested state: only then may a judge that plays be
  // sent to that state for it, and only its yes rests on the studio seeing the state reached.
  [CheckKind.Play]: (raw) => ({
    ask: askOf(raw),
    expect: raw.expect === "no" ? "no" : "yes",
    ...(raw.reaches === PlayReaches.Setup ? { reaches: PlayReaches.Setup } : {}),
  }),
};

/** Normalise one check from planner JSON; returns null for something that is not a check at all. */
export function normalizeCheck(raw: AnyRecord | null | undefined, index = 0): Check | null {
  if (!raw || typeof raw !== "object") return null;
  const kind = String(raw.kind ?? "").toLowerCase();
  const id = slug(raw.id ?? `${kind}-${index + 1}`, `check-${index + 1}`);
  const base = checkBase(raw, id, kind);
  const camera =
    typeof raw.camera === "string" && raw.camera.trim() ? raw.camera.trim().slice(0, CHECK_CAMERA_CHARS) : "";
  if (!Object.hasOwn(KIND_FIELDS, kind)) return { ...base, kind: kind || "unknown" };
  return { ...base, ...KIND_FIELDS[kind as CheckKind](raw, camera) };
}

/**
 * `done`: what the work IS when it is finished, in 2–4 lines the harness can score. Each entry
 * is `{ what, check }` — a sentence a player could check, and the check that measures it — and
 * every check comes back `weight:"identity"`, the field that makes "satisfied" reachable at
 * all. The first director run wrote none: every board read identityTotal 0, no worker could
 * ever finish, no spike ever fired, and the move gate stood open for the whole run.
 */
export function normalizeDone(list: unknown): Array<DoneEntry & { check: Check }> {
  if (!Array.isArray(list)) return [];
  const out: Array<DoneEntry & { check: Check }> = [];
  const seen = new Set<string>();
  for (const [i, raw] of list.slice(0, MAX_DONE).entries()) {
    const entry = doneEntry(raw, i);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
}

/** One `done` line: the sentence, and its check as an identity check that carries the sentence as its note. */
function doneEntry(raw: unknown, i: number): (DoneEntry & { check: Check }) | null {
  if (!raw || typeof raw !== "object") return null;
  const line = raw as AnyRecord;
  const said = String(line.what ?? line.intent ?? line.title ?? "")
    .trim()
    .slice(0, SENTENCE_CHARS);
  const source = line.check && typeof line.check === "object" ? line.check : line;
  const check = normalizeCheck(
    { ...source, id: source.id || line.id || said || `done-${i + 1}`, weight: CheckWeight.Identity },
    i,
  );
  if (!check) return null;
  const what = said || check.note || check.id;
  // The sentence rides with the check: it is what the builder's brief says the check is for.
  if (!check.note) check.note = what;
  return { id: check.id, what, check };
}

/** Words that join two phrases without saying anything about the game. */
const JOINING_WORDS = new Set([
  "and",
  "are",
  "but",
  "for",
  "from",
  "has",
  "have",
  "into",
  "its",
  "not",
  "over",
  "that",
  "the",
  "their",
  "them",
  "then",
  "they",
  "this",
  "was",
  "when",
  "with",
  "you",
  "your",
]);

/** The words a check id and a prose feature can share: three letters up, a plural stripped. */
const wordsOf = (text: unknown): Set<string> =>
  new Set(
    slug(text, "")
      .split("-")
      .map((w) => (w.length >= 4 && w.endsWith("s") ? w.slice(0, -1) : w))
      .filter((w) => w.length >= 3 && !JOINING_WORDS.has(w)),
  );

/**
 * Whether a check carries one of the facet's prose identity features. The planner writes the
 * same feature twice — "props are knocked over by the car" in `identity`, `props-dont-stop-cars`
 * as the check — and only the second one is scored, so a plan whose weights were all left at
 * "normal" produced boards with no identity at all. An exact slug, or two words in common, is
 * the same thing said twice; one word is not (a `sun-visible` vision check is not the "sun" a
 * facet is about).
 */
export function namesIdentityFeature(check: { id?: unknown } | null | undefined, features: unknown): boolean {
  const id = String(check?.id ?? "");
  if (!id || !Array.isArray(features)) return false;
  const own = wordsOf(id);
  return features.some((feature) => sameFeature(id, own, String(feature ?? "").trim()));
}

/** Is `text` the feature check `id` names: the same slug, or two words in common? */
function sameFeature(id: string, own: Set<string>, text: string): boolean {
  if (!text) return false;
  if (slug(text, "") === id) return true;
  const theirs = wordsOf(text);
  return [...own].filter((word) => theirs.has(word)).length >= 2;
}

/**
 * The board a facet starts with. The contract first: `done` is what the worker exits on, so its
 * checks head the board; then the planner's own, each id once (a check also named in `done` is
 * kept once — as the identity check), up to MAX_CHECKS.
 */
function boardOf(checksRaw: AnyRecord[], done: Array<DoneEntry & { check: Check }>): Check[] {
  const seen = new Set<string>();
  const checks: Check[] = [];
  for (const entry of done) {
    seen.add(entry.id);
    checks.push(entry.check);
  }
  for (const [i, entry] of checksRaw.slice(0, Math.max(0, MAX_CHECKS - checks.length)).entries()) {
    const check = normalizeCheck(entry, i);
    if (!check) continue;
    if (done.some((d) => d.id === check.id)) continue;
    let unique = check.id;
    for (let n = 2; seen.has(unique); n++) unique = `${check.id}-${n}`;
    check.id = unique;
    seen.add(unique);
    checks.push(check);
  }
  return checks;
}

/** The cameras a facet is judged through: default, the ones it lists, and the ones its checks name. */
function camerasOf(raw: AnyRecord | null | undefined, checks: readonly Check[]): string[] {
  const listed: string[] = Array.isArray(raw?.cameras)
    ? raw.cameras.map((c: unknown) => String(c).trim()).filter(Boolean)
    : [];
  const fromChecks = checks.map((c) => c.camera).filter((c) => typeof c === "string" && c) as string[];
  return [...new Set([DEFAULT_CAMERA, ...listed, ...fromChecks])].slice(0, MAX_CAMERAS);
}

/** The craft recipes a facet asked to be measured on, once each, lower case. */
function craftOf(raw: AnyRecord | null | undefined): string[] {
  const asked = Array.isArray(raw?.craft) ? raw.craft : [];
  return [...new Set<string>(asked.map((c: unknown) => String(c).trim().toLowerCase()).filter(Boolean))].slice(
    0,
    MAX_CRAFT,
  );
}

/** A list field of a planner facet, as strings, at most `max` of them. */
const stringsOf = (value: unknown, max: number): string[] =>
  Array.isArray(value) ? value.map(String).slice(0, max) : [];

/** Turn one planner facet object into a spec; tolerant of the old prose-only shape. */
export function normalizeFacetSpec(raw: AnyRecord | null | undefined, index = 0): FacetSpec {
  const id = slug(raw?.id ?? `facet-${index + 1}`, `facet-${index + 1}`);
  const intent = String(raw?.intent ?? raw?.brief ?? "").trim();
  const done = normalizeDone(raw?.done);
  const checks = boardOf(Array.isArray(raw?.checks) ? raw.checks : [], done);
  const identity = stringsOf(raw?.identity, MAX_IDENTITY);
  for (const check of checks)
    if (check.weight !== CheckWeight.Identity && namesIdentityFeature(check, identity))
      check.weight = CheckWeight.Identity;
  return {
    id,
    title: String(raw?.title ?? raw?.id ?? `Facet ${index + 1}`).slice(0, FACET_TITLE_CHARS),
    intent,
    // `brief` stays as an alias so every reader of the old plan shape keeps working.
    brief: intent,
    owns: stringsOf(raw?.owns, MAX_OWNS),
    identity,
    // What "done" means, next to the checks that measure it — for the brief and the report.
    ...(done.length ? { done: done.map(({ id: checkId, what }) => ({ id: checkId, what })) } : {}),
    cameras: camerasOf(raw, checks),
    checks,
    // The craft recipes this facet asked to be measured on, by recipe id or by the id of the
    // check the recipe carries. Resolved against the library by withCraftChecks (library.ts)
    // inside decompose, so an id nobody ships reaches the planner's one re-ask.
    craft: craftOf(raw),
    milestones: normalizeMilestones(raw?.milestones),
    budgetShare: Number(raw?.budgetShare) > 0 ? Number(raw?.budgetShare) : 0,
  };
}

/** The facet's milestone ladder, deduplicated by id, at most MAX_MILESTONES long. */
export function normalizeMilestones(list: unknown): Milestone[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: Milestone[] = [];
  for (const [i, raw] of list.slice(0, MAX_MILESTONES).entries()) {
    const m = normalizeMilestone(raw, i);
    if (!m || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

/**
 * The demo one check depends on: a `demo` check's own name, a probe's `demo` scope, or the demo
 * whose end frame (`demo:<name>`) a picture check looks at, so the demo cap never drops the demo a
 * vision check on `demo:rival-battle` needs.
 */
export function demoNameOf(
  check: { kind?: string; name?: unknown; demo?: unknown; camera?: unknown } | null | undefined,
): string {
  if (check?.kind === "demo") return String(check.name ?? "");
  if (check?.kind === "probe") return String(check.demo ?? "");
  return demoOfFrame(check?.camera);
}

/**
 * Every demo the board depends on, for `requiredDemos`: the cap may drop an unreferenced
 * demo, never one a check is waiting on — a dropped demo turns its check unmeasured and the
 * facet can no longer be satisfied.
 */
export function demosNamedByChecks(checks: readonly Check[] | null | undefined): string[] {
  return [...new Set((checks ?? []).map(demoNameOf).filter(Boolean))];
}

/**
 * Validate a spec. Problems are strings the planner can act on; `spec` is the cleaned copy
 * with unusable checks removed, so a run can still proceed on the checks that are sound.
 *
 * With `state` — what the build the work forks from reports through `__studio.state()` — every
 * probe is also dry-run against it and the ones whose paths do not resolve come back as
 * `unsatisfiable`, with the keys that do exist. That is not a rejection: a path the build must
 * start reporting is a legitimate contract. It is the difference between hearing it now and
 * reading `missing: state.…` on every board until morning.
 */
/** What validation found: the problems a planner can act on, and the spec with unusable checks removed. */
export interface SpecValidation<S extends SpecToValidate> {
  ok: boolean;
  problems: string[];
  unsatisfiable: Array<{ id: string; missing: string[] }>;
  stateKeys: string[] | null;
  spec: S & { checks: Check[]; milestones: Milestone[] };
}

/** What a spec is validated against: what the build it forks from registers and reports. */
interface ValidationContext {
  cameras?: string[] | null;
  demos?: string[] | null;
  state?: unknown;
  demoStates?: unknown;
}

/** Kinds whose check is an expression over numbers. */
const EXPRESSION_KINDS = new Set<string>([CheckKind.Pixel, CheckKind.Probe, CheckKind.Metric]);
/** Kinds whose check is one yes/no question. */
const QUESTION_KINDS = new Set<string>([CheckKind.Vision, CheckKind.Play]);

/** The field a check of its kind cannot do without, when it is missing. */
function missingField(check: Check, where: string): string | null {
  if (check.kind === CheckKind.Scene && !check.js) return `${where}: scene check needs "js"`;
  if (EXPRESSION_KINDS.has(check.kind) && !check.expr) return `${where}: ${check.kind} check needs "expr"`;
  if (check.kind === CheckKind.Demo && !check.name) return `${where}: demo check needs "name"`;
  if (QUESTION_KINDS.has(check.kind) && !check.ask)
    return `${where}: ${check.kind} check needs "ask" (one yes/no question)`;
  return null;
}

/** An expression that does not parse, for the kinds that carry one. */
function badExpression(check: Check, where: string): string | null {
  const parsed = EXPRESSION_KINDS.has(check.kind) || (check.kind === CheckKind.Demo && check.expr !== "ok");
  if (!parsed) return null;
  try {
    parseExpr(check.expr);
    return null;
  } catch (err: any) {
    return `${where}: expression "${check.expr}" does not parse — ${err.message}`;
  }
}

/** A check that measures how much the build draws instead of what a player gets (loop/check-lint.ts). */
function measuresTheDrawing(check: Check, where: string): string | null {
  const finding = lintCheck(check);
  return finding ? `${where}: ${finding.message}` : null;
}

/**
 * Why a check cannot be used at all, or null for a sound one. Validation only: a board already
 * running is scored on the checks it was started with, whatever this says about them now.
 */
function checkProblem(specId: string, check: Check): string | null {
  const where = `facet ${specId} check ${check.id}`;
  if (!CHECK_KINDS.includes(check.kind)) return `${where}: unknown kind "${check.kind}" (use ${CHECK_KINDS.join("/")})`;
  return missingField(check, where) ?? badExpression(check, where) ?? measuresTheDrawing(check, where);
}

/** Add a sentence to a check's note, after whatever it already says. */
function addNote(check: Check, sentence: string): void {
  check.note = [check.note, sentence].filter(Boolean).join("; ");
}

/**
 * A camera or a demo the build does not declare yet is a request to the builder, not an error —
 * the brief tells the builder to register it. Recorded as a note, never dropped.
 */
function noteUnregistered(check: Check, { cameras, demos }: ValidationContext): void {
  const camera = check.camera;
  // A frame the pass takes itself (a demo's end, the drive's corner) is no camera to register.
  const unregisteredCamera =
    Array.isArray(cameras) && camera && !cameras.includes(camera) && !camera.startsWith("eye:") && !isPassFrame(camera);
  if (unregisteredCamera) addNote(check, `camera "${camera}" is not registered yet — register it in config.cameras`);
  const demoNamed = demoNameOf(check);
  const unregisteredDemo = Array.isArray(demos) && demoNamed && !demos.includes(demoNamed);
  if (unregisteredDemo) addNote(check, `demo "${demoNamed}" is not registered yet — add it to config.demos`);
}

/**
 * A milestone's check is validated like any other; a bad one is dropped and the milestone stays
 * (the taste judge then decides whether the move was delivered).
 */
function validateMilestones(spec: SpecToValidate, context: ValidationContext, problems: string[]): Milestone[] {
  const milestones: Milestone[] = [];
  for (const milestone of spec.milestones ?? []) {
    if (!milestone?.check) {
      milestones.push(milestone);
      continue;
    }
    const inner = validateFacetSpec({ id: spec.id, intent: spec.intent, checks: [milestone.check] }, context);
    const [kept] = inner.spec.checks;
    if (inner.spec.checks.length === 1 && kept) {
      milestones.push({ ...milestone, check: { ...kept, milestone: milestone.id, origin: CheckOrigin.Milestone } });
      continue;
    }
    problems.push(...inner.problems.map((p) => `${p} (milestone ${milestone.id}: check dropped, milestone kept)`));
    const { check: _check, ...rest } = milestone;
    milestones.push(rest);
  }
  return milestones;
}

/**
 * A board that is mostly vision checks cannot be measured; the problem the planner is told. A
 * screen part (`critic: "screen"`, the UI or HUD) is exempt: its looks are its work, and a
 * mechanical majority there only buys counts of what it draws.
 */
function visionHeavy(specId: string, kept: readonly Check[], critic: unknown = null): string | null {
  if (critic === SCREEN_CRITIC) return null;
  const visionCount = kept.filter((c) => c.kind === CheckKind.Vision).length;
  if (kept.length < MIN_BOARD_FOR_VISION_RULE || visionCount <= kept.length / 2) return null;
  return `facet ${specId}: ${visionCount} of ${kept.length} checks are vision — make the majority scene/pixel/probe/demo`;
}

/**
 * The dry run against the state the build reports; the note goes to the builder, who is the one
 * who can either expose the path or correct it.
 */
function noteUnsatisfiable(
  kept: readonly Check[],
  unsatisfiable: Array<{ id: string; missing: string[] }>,
  stateKeys: string[] | null,
): void {
  const reports = (stateKeys ?? []).slice(0, STATE_KEYS_NAMED).join(", ") || "nothing";
  for (const entry of unsatisfiable) {
    const check = kept.find((c) => c.id === entry.id);
    if (!check) continue;
    addNote(
      check,
      `the build does not report ${entry.missing.join(", ")} yet — expose it in __studio.state() (which reports: ${reports})`,
    );
  }
}

export function validateFacetSpec<S extends SpecToValidate>(
  spec: S,
  { cameras = null, demos = null, state = null, demoStates = null }: ValidationContext = {},
): SpecValidation<S> {
  const problems: string[] = [];
  const kept: Check[] = [];
  if (!spec.intent) problems.push(`facet ${spec.id}: no intent/brief`);
  const milestones = validateMilestones(spec, { cameras, demos, state, demoStates }, problems);
  for (const check of spec.checks ?? []) {
    const bad = checkProblem(spec.id, check);
    if (bad) {
      problems.push(bad);
      continue;
    }
    noteUnregistered(check, { cameras, demos });
    kept.push(check);
  }
  if ((spec.checks ?? []).length > 0 && kept.length === 0) problems.push(`facet ${spec.id}: every check was unusable`);
  const heavy = visionHeavy(spec.id, kept, spec.critic);
  if (heavy) problems.push(heavy);
  const dryRun = dryRunChecks(kept, { state, demoStates });
  const { stateKeys } = dryRun;
  // A harness check over something this build does not have (a front-end, a measuring HUD) does
  // not apply to it: no "expose it" note pushes the builder to add one (loop/harness-needs.ts).
  const unsatisfiable = dryRun.unsatisfiable.filter(
    (entry) =>
      !notThisBuildsQuestion(
        kept.find((c) => c.id === entry.id),
        entry.missing,
      ),
  );
  noteUnsatisfiable(kept, unsatisfiable, stateKeys);
  const keptIds = new Set(kept.map((c) => c.id));
  const done = (spec.done ?? []).filter((d) => keptIds.has(d.id));
  return {
    ok: problems.length === 0,
    problems,
    unsatisfiable,
    stateKeys,
    spec: { ...spec, checks: kept, milestones, ...(spec.done ? { done } : {}) },
  };
}

/** Where a milestone stands on the ladder: done, the current move, or queued. */
function milestoneMark(id: string, done: readonly string[], current: string | null): string {
  if (done.includes(id)) return "[x]";
  if (current === id) return "[>]";
  return "[ ]";
}

/** The ladder for a brief: done ones ticked, the current move marked, the rest queued. */
export function renderMilestones(
  milestones: unknown,
  { done = [], current = null }: { done?: readonly string[]; current?: string | null } = {},
): string {
  const list: Milestone[] = Array.isArray(milestones) ? milestones : [];
  if (!list.length) return "";
  return list
    .map(
      (m, i) =>
        `${milestoneMark(m.id, done, current)} ${i + 1}. ${m.what}${m.check ? ` — measured by check ${m.check.id}` : ""}`,
    )
    .join("\n");
}

// ── harness-owned checks ───────────────────────────────────────────────────────────────────

/**
 * Checks the loop itself puts on every plan (HARNESS-POSTMORTEM-SHOOTER.md §4.2–4.3). They
 * prove the two things the user notices first and no planner check ever covered: the screen
 * the user sees is the screen the judge sees (one HUD, drawn into the canvas, no DOM UI), and
 * a human's input reaches the game (the mouse turns the camera, the keys move the player).
 * `origin: "harness"`; a planner re-ask cannot drop them and a builder cannot edit them.
 */
export const HARNESS_CHECKS: Record<string, AnyRecord & { expr?: string; note: string; needs?: string[] }> = {
  "no-dom-ui": {
    kind: CheckKind.Scene,
    weight: CheckWeight.Identity,
    origin: CheckOrigin.Harness,
    js: "domUi().length === 0",
    detail: "'visible DOM elements outside the canvas: ' + domUi().join(', ')",
    note: "harness-owned: every visible element must be drawn into the canvas (use __studio.hud); the judge never sees DOM",
  },
  "single-hud": {
    kind: CheckKind.Scene,
    weight: CheckWeight.Identity,
    origin: CheckOrigin.Harness,
    js: "count('hud') === 1",
    detail: "'hud-tagged objects: ' + objects('hud').map(o => o.type + (o.name ? '#' + o.name : '')).join(', ')",
    note: "harness-owned: exactly one object tagged hud — the template's overlay; a second HUD is a duplicate the user sees twice",
  },
  "look-turns-camera": {
    kind: CheckKind.Probe,
    weight: CheckWeight.Identity,
    origin: CheckOrigin.Harness,
    expr: "abs(delta('player.yaw')) > 0.01",
    note: "harness-owned: after the scripted look (56 px right) player().yaw changed — the mouse path from ctx.look to the camera works",
  },
  "keys-move-player": {
    kind: CheckKind.Probe,
    weight: CheckWeight.Identity,
    origin: CheckOrigin.Harness,
    // `abs(delta(path)) > 0` and not `delta(path) != 0`: an axis the game does not report reads
    // undefined, and `undefined != 0` is true — the old body passed on a game with no player at
    // all. `needs` names the same two paths, so a build whose player only exists after the play
    // script (a title screen) is reported unmeasured instead of green (checks.ts
    // needsNotReported compares needs against the paths delta() itself names).
    expr: "abs(delta('player.x')) > 0 || abs(delta('player.z')) > 0",
    needs: ["player.x", "player.z"],
    note: "harness-owned: after the scripted W/A hold player().x or .z changed — the key path from ctx.keys to the controller works",
  },
  // The HUD's own measurements (template hud.js generation 2): what a player notices about a HUD
  // is how much of the view it takes and whether its pieces run into each other — never how many
  // pieces it is drawn from. `needs` keeps an older HUD that measures nothing unmeasured, not
  // failed. The budget is the declared kind's (loop/hud-budget.ts); withHarnessChecks fills it in.
  "hud-coverage": {
    kind: CheckKind.Probe,
    weight: CheckWeight.Normal,
    origin: CheckOrigin.Harness,
    expr: `hud.coverage <= ${DEFAULT_HUD_BUDGET}`,
    needs: ["hud.coverage"],
    note: "harness-owned: the HUD covers at most its kind's share of the frame — keep the middle of the view for the game",
  },
  "hud-overlap": {
    kind: CheckKind.Probe,
    weight: CheckWeight.Normal,
    origin: CheckOrigin.Harness,
    expr: "len(hud.overlaps) == 0",
    needs: ["hud.overlaps"],
    note: "harness-owned: no two HUD items run into each other",
  },
  // A game with a front-end (title → start → countdown) declares `config.flow()`; the evidence
  // pass begins it, and this asks whether that put the game into play. It reads the early sample
  // (the state reachPlay left, before the drive): a race that ends or a player who dies during
  // the drive still reached play. A game that reports no flow is not asked (loop/harness-needs.ts):
  // undeclared games are not held to a menu they never had.
  "reaches-play": {
    kind: CheckKind.Probe,
    weight: CheckWeight.Identity,
    origin: CheckOrigin.Harness,
    expr: "early.flow.playing == true",
    needs: ["flow.playing"],
    note: "harness-owned: after begin the game is in play (state().flow.playing) — the front-end hands the player the controls",
  },
  // A race a bot that only holds the throttle can win is no challenge. The evidence pass races that
  // bot when the board carries this check (evidence.ts `raceThrottleBot`: the throttle held, the game's racing
  // line steering, never a brake) and the probe reads the state the race left. A game that reports
  // no `race.position` is not asked (`needs`); a race the pass did not run is unmeasured.
  "throttle-bot-loses": {
    kind: CheckKind.Probe,
    weight: CheckWeight.Normal,
    origin: CheckOrigin.Harness,
    after: ProbeAfter.ThrottleBot,
    expr: "race.position > 1",
    needs: ["race.position"],
    note: "harness-owned: a bot that only holds the throttle (steered by the game's racing line, never braking) must not win the race — report race.position (1 = leading) and race.finished in state()",
  },
};

/** The harness checks that only hold once the game is in play: off the front-end owner's board. */
const IN_PLAY_CHECKS: ReadonlySet<string> = new Set([
  "reaches-play",
  "hud-coverage",
  "keys-move-player",
  "look-turns-camera",
  "throttle-bot-loses",
]);

/** The kind's throttle, from a kinds.ts that may predate `throttleFor` (an edited copy an upgrade kept). */
function throttleOf(game: AnyRecord | null): string[] {
  return typeof kinds.throttleFor === "function" ? kinds.throttleFor(game) : [];
}

/** The `hud-coverage` body for a HUD whose kind allows `budget` of the frame. */
function hudCoverage(budget: number): AnyRecord {
  return {
    expr: `hud.coverage <= ${budget}`,
    note: `harness-owned: the HUD covers at most ${Math.round(budget * 100)}% of the frame — keep the middle of the view for the game`,
  };
}

/**
 * One input probe as `{ expr, note }`, from whatever `inputProbesFor` answered: a kind may
 * describe its axes as a string or as the whole check body. A trait that is declared but whose
 * kind names no axis falls back to the template's own expression rather than dropping the
 * check silently — "declare mouseLook: true" is the documented remedy and must do something.
 */
function inputProbe(raw: unknown, fallbackId: string): { expr: string; note: string; needs?: string[] } {
  const body = HARNESS_CHECKS[fallbackId]!;
  let expr = body.expr as string;
  let note = body.note;
  if (hasText(raw)) {
    expr = raw.trim();
  } else if (isRecord(raw) && hasText(raw.expr)) {
    expr = raw.expr.trim();
    if (hasText(raw.note)) note = raw.note.trim();
  }
  // `needs` is read off the expression the check actually carries, never inherited: a kind that
  // moves on x and y must not be asked for the template's x and z, and a check whose needs name
  // a path its own delta() does not can never report the early state missing (checks.ts
  // needsNotReported), or "this game has no player yet" would read as "the controls work". Only a check whose harness body declares needs gets them.
  const needs = body.needs ? deltaPathsIn(expr) : [];
  return { expr, note, ...(needs.length ? { needs } : {}) };
}

/** The dotted paths an expression reads through `delta(...)`, in order, at most four. */
function deltaPathsIn(expr: unknown): string[] {
  const found = [...String(expr).matchAll(/delta\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]!);
  return [...new Set(found)].slice(0, MAX_DELTA_PATHS);
}

/** The harness checks a board of this game carries, by id, before the front-end owner's are left off. */
function harnessCheckIds(game: AnyRecord | null, { owner, screen }: { owner: boolean; screen: boolean }): string[] {
  const traits = normalizeGameTraits(game);
  // `screen: false` — a game the user brought with its own UI (DOM menus, its own HUD) keeps
  // it; the one-screen checks describe the template's screen, not this game's.
  const driven = traits.keyboardMove || traits.mouseLook;
  return [
    ...(screen && traits.hud ? ["no-dom-ui", "single-hud", "hud-coverage", "hud-overlap"] : []),
    ...(owner && traits.mouseLook ? ["look-turns-camera"] : []),
    ...(owner && traits.keyboardMove ? ["keys-move-player"] : []),
    ...(owner && driven ? ["reaches-play"] : []),
    // A kind with a throttle (a racer, a craft) races the throttle-only bot on the entry owner's board.
    ...(owner && throttleOf(game).length ? ["throttle-bot-loses"] : []),
  ];
}

/**
 * The harness-owned checks a facet carries, conditional on what the plan says the game IS:
 * the screen checks on every facet of a game with a HUD (any facet can paint a second one, or
 * crowd the frame), the input checks on the facet that owns main.js and on the integration
 * facet (they own the player) when the game is mouse-looked / keyboard-moved, and with them
 * `reaches-play` — and, for a kind with a throttle, `throttle-bot-loses`. Existing ids are
 * replaced by the harness definition, never duplicated.
 *
 * Every trait is off until something declares it (loop/kinds.ts), so a game nobody described
 * carries no harness check at all: the four checks describe the template's screen and the
 * template's controls, and a board game or a builder has neither. The two input checks read
 * the declared kind's own axes, so a top-down game is asked whether x, y or z moved and not
 * whether the first-person controller's x or z did.
 *
 * `keepsFrontEnd` is the worker that owns the front-end (`setup {"begin":false}`): its evidence
 * and judges stay on the title (evidence.ts reachPlay), so the checks that only hold in play —
 * in play, the controls move the player, the in-play HUD budget — are left off its board.
 */
export function withHarnessChecks<S extends { checks?: Check[] }>(
  spec: S,
  {
    ownsMain = false,
    role = "facet",
    game = null,
    screen = true,
    keepsFrontEnd = false,
  }: { ownsMain?: boolean; role?: string; game?: AnyRecord | null; screen?: boolean; keepsFrontEnd?: boolean } = {},
): S & { checks: Check[] } {
  const traits = normalizeGameTraits(game);
  const owner = ownsMain || role === "integration";
  const probes = inputProbesFor(game) ?? {};
  const wanted = harnessCheckIds(game, { owner, screen }).filter((id) => !keepsFrontEnd || !IN_PLAY_CHECKS.has(id));
  const overrides: Record<string, AnyRecord> = {
    "look-turns-camera": inputProbe(probes.look, "look-turns-camera"),
    "keys-move-player": inputProbe(probes.move, "keys-move-player"),
    "hud-coverage": hudCoverage(hudBudgetFor(traits) ?? DEFAULT_HUD_BUDGET),
  };
  const checks = (spec.checks ?? []).filter((c) => !wanted.includes(c.id));
  for (const id of wanted)
    checks.push(normalizeCheck({ id, ...HARNESS_CHECKS[id], ...(overrides[id] ?? {}) }, checks.length)!);
  return { ...spec, checks };
}

/**
 * A kind's family: its critic and whether it has eyes. The catalogue is gated on this and not
 * on the kind's name, because a first-person run and a third-person run learn the same
 * lessons and hiding one from the other would throw away most of what the runs know.
 */
function kindFamily(kind: unknown): string | null {
  if (!isGameKind(kind)) return null;
  return `${criticFor({ kind })}/${wantsEyeCameras({ kind }) ? "eyes" : "flat"}`;
}

/**
 * The requested state, on every board: a harness-owned probe that says the scout's
 * setup landed — the map, mode or scene the brief is about is what the cameras are looking
 * at. A build judged on the wrong map used to pass every pixel check; now it fails this one.
 */
export function withRequestedStateCheck<S extends { checks?: Check[] }>(
  spec: S,
  { expr = null, note = "" }: { expr?: string | null; note?: string } = {},
): S {
  if (!expr) return spec;
  const checks = (spec.checks ?? []).filter((c) => c.id !== "requested-state");
  checks.push(
    normalizeCheck(
      {
        id: "requested-state",
        kind: CheckKind.Probe,
        expr,
        weight: CheckWeight.Identity,
        origin: CheckOrigin.Harness,
        note: `harness-owned: the setup script must land on the requested state before anyone looks${note ? ` — ${note}` : ""}`,
      },
      checks.length,
    )!,
  );
  return { ...spec, checks };
}

/** What a metric check ratchets towards, as its brief line says it. */
function metricWords(c: Check): string {
  const better = c.goal === "max" ? "higher" : "lower";
  const target = typeof c.target === "number" ? `, target ${c.target}` : "";
  return `metric on ${c.camera}: ${c.expr} → ${better} is better (ratchet, tol ${c.tol ?? METRIC_TOLERANCE}${target})`;
}

/** Which state a probe reads, for a brief: a demo's end, the throttle-only bot's race, or the drive's. */
function probeScopeWords(c: Check): string {
  if (c.demo) return ` on the state left by demo "${c.demo}"`;
  if (c.after === ProbeAfter.ThrottleBot) return " on the state a throttle-only bot's race left";
  return "";
}

/** What each kind of check measures, as a brief's line says it. */
const CHECK_WORDS: Record<CheckKind, (c: Check) => string> = {
  [CheckKind.Scene]: (c) => `scene: ${c.js}`,
  [CheckKind.Pixel]: (c) => `pixel on ${c.camera}: ${c.expr}`,
  [CheckKind.Metric]: metricWords,
  [CheckKind.Probe]: (c) => `probe${probeScopeWords(c)}: ${c.expr}`,
  [CheckKind.Demo]: (c) =>
    `demo "${c.name}"${c.expr && c.expr !== "ok" ? ` then ${c.expr}` : " runs to its end state"}`,
  [CheckKind.Vision]: (c) =>
    `vision on ${c.camera}${c.crop ? ` crop [${c.crop.join(",")}]` : ""}: "${c.ask}" → ${c.expect}`,
  [CheckKind.Play]: (c) => `play: "${c.ask}" → ${c.expect}`,
};

/** One check as a brief's line: its id and flags, what it measures, its note, and where it came from. */
function checkLine(c: Check): string {
  const flags = [c.weight === CheckWeight.Identity ? "identity" : null, c.hard ? "hard" : null]
    .filter(Boolean)
    .join(", ");
  const words = Object.hasOwn(CHECK_WORDS, c.kind) ? CHECK_WORDS[c.kind as CheckKind] : CHECK_WORDS[CheckKind.Play];
  const fromJudge = c.origin === CheckOrigin.Judge ? " [from the judge's defect list]" : "";
  return `- ${c.id}${flags ? ` [${flags}]` : ""} — ${words(c)}${c.note ? ` (${c.note})` : ""}${fromJudge}`;
}

/** The checks a brief should show, one per line, with what they measure. */
export function renderChecks(checks: readonly Check[] | null | undefined): string {
  return (checks ?? []).map(checkLine).join("\n");
}

/** Words a check is about, for recipe retrieval: id tokens, kind, camera, ask words. */
export function checkTokens(check: Partial<Check> | null | undefined): string[] {
  const words = new Set<string>();
  const add = (text: unknown): void => {
    for (const w of String(text ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/))
      if (w.length >= 3) words.add(w);
  };
  add(check?.id);
  add(check?.kind);
  add(check?.camera);
  add(check?.ask);
  add(check?.note);
  add(check?.name);
  add(check?.demo);
  add(check?.defect);
  return [...words];
}

/**
 * The identity metric a plan with reference stills carries (WP4d): style distance on the
 * facet's primary camera, ratcheted down. Added by the harness when the planner did not, so
 * "looks like the stills" is on every board of a run that has stills.
 */
export function withStyleMetric<S extends { checks?: Check[]; cameras?: string[] }>(
  spec: S,
  { hasReference = false }: { hasReference?: boolean } = {},
): S {
  if (!hasReference) return spec;
  if ((spec.checks ?? []).some((c) => c.kind === "metric" && /styleDistance/.test(String(c.expr ?? "")))) return spec;
  const camera =
    (spec.cameras ?? []).find((c) => c !== DEFAULT_CAMERA && !String(c).startsWith("eye:")) ?? DEFAULT_CAMERA;
  const check = normalizeCheck(
    {
      id: `style-distance-${slug(camera, DEFAULT_CAMERA)}`,
      kind: CheckKind.Metric,
      camera,
      expr: "styleDistance",
      goal: "min",
      tol: 0.02,
      weight: CheckWeight.Identity,
      origin: CheckOrigin.Harness,
      note: "harness-owned: distance to the nearest reference still on the primary camera — lower is better; a build that moves it up regresses",
    },
    (spec.checks ?? []).length,
  );
  return { ...spec, checks: [...(spec.checks ?? []), check!] };
}

// ── check catalogue ────────────────────────────────────────────────────────────────────────

/**
 * Version 2 of the catalogue carries a second map beside `checks`: `retired`, where the seed
 * upgrade moves an id whose body now lives in a craft recipe, statistics and all. It must be
 * read and written back by every load/save pair, or the first `flagRarelyMeasurable` cycle
 * deletes every number the migration was careful to preserve.
 */
export async function loadCatalogue(workspace: string): Promise<Catalogue> {
  let text: string;
  try {
    text = await readFile(path.join(workspace, "library", "checks.json"), "utf8");
  } catch {
    return { version: 1, checks: {}, retired: {} };
  }
  try {
    const parsed = JSON.parse(text);
    return {
      version: Number(parsed?.version) === 2 ? 2 : 1,
      checks: parsed?.checks && typeof parsed.checks === "object" ? parsed.checks : {},
      retired: parsed?.retired && typeof parsed.retired === "object" ? parsed.retired : {},
    };
  } catch {
    return { version: 1, checks: {}, retired: {}, unreadable: true };
  }
}

/**
 * Write the catalogue whole — a temporary file renamed over the old one, so a crash mid-write
 * leaves the last good catalogue — and never over one that could not be read.
 */
export async function saveCatalogue(
  workspace: string,
  catalogue: Pick<Catalogue, "checks"> & { retired?: Record<string, AnyRecord>; unreadable?: boolean },
): Promise<void> {
  if (catalogue.unreadable) throw new Error("the check catalogue could not be read; it is left as it is");
  const dir = path.join(workspace, "library");
  await mkdir(dir, { recursive: true });
  const sorted = (map: Record<string, unknown> | undefined): Record<string, unknown> =>
    Object.fromEntries(Object.entries(map ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)));
  const retired = sorted(catalogue.retired);
  const body = { version: 2, checks: sorted(catalogue.checks), ...(Object.keys(retired).length ? { retired } : {}) };
  const file = path.join(dir, "checks.json");
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`);
  await rename(temporary, file).catch(async (err) => {
    await rm(temporary, { force: true });
    throw err;
  });
}

/**
 * Whether a catalogue entry has earned a place in the planner's prompt. What the seed itself
 * ships is no longer a hypothesis: since the craft opinions left for `library/recipes` the
 * catalogue holds only the five technical checks that say "this is a game and the harness can
 * see and drive it", and a game that keeps failing one of them has a defect, not a bad check.
 * Content the runs grew (origin judge / spike) is shown only once it has caught a defect at
 * least LEARNED_MIN_CATCHES times across LEARNED_MIN_RUNS runs — a one-run defect is not
 * knowledge. Everything else (a check a planner hand-wrote) is still voted out by use: shown
 * until STALE_SEED_USES uses have gone by without it ever passing.
 */
export function catalogueEntryEarned(entry: CatalogueEntry): boolean {
  const uses = entry.uses ?? 0;
  const passes = entry.passes ?? 0;
  const catches = entry.catches ?? 0;
  const runs = Array.isArray(entry.runs) ? entry.runs.length : 0;
  if (entry.origin === CheckOrigin.Seed) return true;
  if (learnedByRuns(entry)) return catches >= LEARNED_MIN_CATCHES && runs >= LEARNED_MIN_RUNS;
  return !(uses >= STALE_SEED_USES && passes === 0);
}

/**
 * The catalogue as the planner reads it: reusable checks with their known-good thresholds.
 * Entries are grouped by genre — a seeded `pack` or the `genres` the plans that used a learned
 * check declared — so the planner selects a whole group from the goal; the rest are the general
 * list. Only entries that earned it (see catalogueEntryEarned) are shown, so seed content can
 * be displaced by what the runs learned. Harness-owned checks are listed as already on the
 * board, so the planner does not re-invent them. An entry the lint refuses (a floor on how much
 * the build draws, learned before the lint existed) is never offered again.
 */
export function renderCatalogueForPlanner(
  catalogue: Pick<Catalogue, "checks"> | null | undefined,
  options: number | { limit?: number; game?: AnyRecord | null; screen?: boolean } | null = {},
): string {
  const {
    limit = CATALOGUE_LIMIT,
    game = null,
    screen = true,
  }: { limit?: number; game?: AnyRecord | null; screen?: boolean } = typeof options === "number"
    ? { limit: options }
    : (options ?? {});
  const wantedFamily = kindFamily(game?.kind ?? null);
  const all = Object.entries(catalogue?.checks ?? {}).filter(
    ([id, c]) => !HARNESS_CHECKS[id] && catalogueEntryEarned(c) && forFamily(c, wantedFamily) && !lintCheck(c),
  );
  const general = all
    .filter(([, c]) => groupsOf(c).length === 0)
    .sort(([, a], [, b]) => (b.passes ?? 0) - (a.passes ?? 0) || (b.uses ?? 0) - (a.uses ?? 0))
    .slice(0, limit);
  const packs = packsOf(all);
  if (general.length === 0 && packs.size === 0) return "";
  const lines = ["## Check catalogue — reuse these ids and thresholds where they fit"];
  if (general.length) lines.push(...general.map(catalogueLine));
  for (const [pack, entries] of [...packs.entries()].sort()) {
    lines.push(
      "",
      `### Learned on "${pack}" games — take what fits when the goal is one (a threshold another game taught is a hypothesis here, not a rule)`,
      ...entries.slice(0, limit).map(catalogueLine),
    );
  }
  lines.push("", ridingLine(game, screen));
  return lines.join("\n");
}

/**
 * What a run on another sort of game learned is not automatically knowledge about this one,
 * but the kind's name is too fine a gate: an entry recorded under exactly one FAMILY is offered
 * only to that family; one recorded under two families, or under none, is general.
 */
function forFamily(entry: CatalogueEntry, wantedFamily: string | null): boolean {
  const families = [...new Set((Array.isArray(entry?.kinds) ? entry.kinds : []).map(kindFamily).filter(Boolean))];
  return families.length !== 1 || !wantedFamily || families[0] === wantedFamily;
}

/** The genre groups an entry belongs to: its seeded pack, and the genres of the plans that used it. */
const groupsOf = (c: CatalogueEntry): string[] => [
  ...new Set([...(c.pack ? [c.pack] : []), ...(Array.isArray(c.genres) ? c.genres : [])]),
];

/** The catalogue entries grouped by genre, an entry in every group it belongs to. */
function packsOf(all: Array<[string, CatalogueEntry]>): Map<string, Array<[string, CatalogueEntry]>> {
  const packs = new Map<string, Array<[string, CatalogueEntry]>>();
  for (const entry of all) {
    for (const group of groupsOf(entry[1])) {
      const list = packs.get(group) ?? [];
      list.push(entry);
      packs.set(group, list);
    }
  }
  return packs;
}

/** One catalogue entry as the planner reads it: its definition, its note, and what the runs made of it. */
function catalogueLine([id, c]: [string, CatalogueEntry]): string {
  const def = {
    id,
    kind: c.kind,
    ...(c.camera ? { camera: c.camera } : {}),
    ...(c.js ? { js: c.js } : {}),
    ...(c.expr ? { expr: c.expr } : {}),
    ...(c.name ? { name: c.name } : {}),
    ...(c.ask ? { ask: c.ask } : {}),
    ...(c.crop ? { crop: c.crop } : {}),
    ...(Array.isArray(c.needs) && c.needs.length ? { needs: c.needs } : {}),
    ...(c.optional === true ? { optional: true } : {}),
  };
  const learned = learnedByRuns(c)
    ? ` [learned from ${(c.runs ?? []).length} runs, caught a defect ${c.catches ?? 0}×]`
    : "";
  return `- ${JSON.stringify(def)}${c.note ? ` — ${c.note}` : ""} (used ${c.uses ?? 0}×, passed ${c.passes ?? 0}×)${learned}`;
}

/** Did the runs grow this entry — a judge's defect, or a spike's technique — rather than a planner write it? */
const learnedByRuns = (entry: { origin?: string }): boolean =>
  entry.origin === CheckOrigin.Judge || entry.origin === CheckOrigin.Spike;

/**
 * What actually rides on THIS game's board, not the four ids the table happens to hold: a game
 * that declared nothing carries none of them, and telling the planner otherwise is the lie that
 * made every plan re-declare a HUD rule its game does not have.
 */
function ridingLine(game: AnyRecord | null, screen: boolean): string {
  const riding = withHarnessChecks({ id: "board", checks: [] as Check[] }, { ownsMain: true, game, screen }).checks.map(
    (c) => c.id,
  );
  if (!riding.length)
    return `No harness-owned checks ride on this game's board — declare hud, mouseLook or keyboardMove in game if it has them.`;
  return `Already on this game's board (harness-owned, do not re-declare): ${riding.join(", ")}.${ridingWords(riding, hudBudgetFor(game))}`;
}

/** What the harness checks riding on a board ask, a sentence each, for the planner. */
function ridingWords(riding: readonly string[], budget: number | null): string {
  const screenRides = riding.includes("no-dom-ui") || riding.includes("single-hud");
  const inputRides = riding.includes("look-turns-camera") || riding.includes("keys-move-player");
  const hudRides = riding.includes("hud-coverage") && budget !== null;
  return [
    screenRides ? " Every visible element is drawn into the canvas — no DOM UI, one HUD." : "",
    hudRides
      ? ` The HUD covers at most ${Math.round((budget ?? 0) * 100)}% of the frame and its items do not overlap.`
      : "",
    inputRides ? " The input checks and reaches-play ride on the facet that owns main." : "",
    riding.includes("throttle-bot-loses")
      ? " On the facet that owns main, a bot that only holds the throttle must not win the race (throttle-bot-loses: report race.position and race.finished)."
      : "",
  ].join("");
}

/**
 * Outcome accounting for the catalogue: a check that appeared in a spec is used; one the
 * facet ended with passing has passed; one that measurably failed at some point in the facet
 * (`everFailed`) caught a defect. New ids enter with their own origin (planner, judge, spike,
 * harness), the run they came from and the genres the plan declared — that is how a defect
 * the judge named in one shooter becomes, after a second shooter confirms it, a catalogue
 * check under "fps" that nobody hand-wrote.
 */
export function recordCatalogueOutcomes<C extends Pick<Catalogue, "checks">>(
  catalogue: C,
  spec: { checks?: readonly Check[] } | null | undefined,
  finalBoard: BoardOutcomes | null | undefined,
  origin: string = CheckOrigin.Planner,
  {
    runId = null,
    genres = [],
    everFailed = null,
    kind = null,
  }: {
    runId?: string | null;
    genres?: unknown;
    everFailed?: Set<string> | null;
    kind?: string | { kind?: string } | null;
  } = {},
): C {
  catalogue.checks ??= {};
  const { checks } = catalogue;
  // The kind rides beside the genres so a later run knows what sort of game taught this.
  const provenance = { runId, genres, kind: declaredKindOf(kind) };
  for (const check of spec?.checks ?? []) {
    if (!theCatalogues(check)) continue;
    const entry = entryFor(checks, check, origin);
    countOutcome(entry, check, finalBoard, everFailed);
    stampProvenance(entry, provenance);
    checks[check.id] = entry;
  }
  return catalogue;
}

/** The kind a plan declared, from its name or from its game block. */
function declaredKindOf(kind: string | { kind?: string } | null): string | null {
  if (typeof kind === "string") return kind;
  return typeof kind?.kind === "string" ? kind.kind : null;
}

/**
 * The loop's own checks and the library's own are not the catalogue's to learn about: a craft
 * check copied onto a board belongs to its recipe, which is credited and blamed by its own
 * outcome gate, and a copy trickling back into checks.json would ship two definitions of one id.
 * A planner that hand-writes a craft id still enters as its own opinion — at that point it is
 * that plan's, not the seed's. A floor on how much the build draws (loop/check-lint.ts) is not
 * counted either: a board started before the lint still scores it, but a pass there taught nothing.
 */
const theCatalogues = (check: Check): boolean =>
  check.origin !== CheckOrigin.Harness && check.origin !== CheckOrigin.Craft && !check.fromRecipe && !lintCheck(check);

/** The fields of a check the catalogue keeps as its definition. */
const CATALOGUED_FIELDS = [
  "kind",
  "camera",
  "js",
  "expr",
  "name",
  "ask",
  "crop",
  "expect",
  "detail",
  "needs",
  "optional",
];

/** The catalogue's entry for a check — a new one with the check's own origin — with its definition brought up to date. */
function entryFor(checks: Record<string, CatalogueEntry>, check: Check, origin: string): CatalogueEntry {
  const entry: CatalogueEntry = checks[check.id] ?? {
    kind: check.kind,
    uses: 0,
    passes: 0,
    catches: 0,
    origin: check.origin ?? origin,
  };
  for (const key of CATALOGUED_FIELDS) if (check[key] !== undefined) entry[key] = check[key];
  if (check.note && !entry.note) entry.note = check.note;
  if (check.defect && !entry.note) entry.note = `judge defect: ${check.defect}`;
  return entry;
}

/** A use, a pass at the end, and a catch when it measurably failed at some point in the facet. */
function countOutcome(
  entry: CatalogueEntry,
  check: Check,
  finalBoard: BoardOutcomes | null | undefined,
  everFailed: Set<string> | null,
): void {
  entry.uses = (entry.uses ?? 0) + 1;
  const pass = finalBoard?.[check.id]?.pass;
  if (pass === true) entry.passes = (entry.passes ?? 0) + 1;
  if (everFailed?.has?.(check.id) || pass === false) entry.catches = (entry.catches ?? 0) + 1;
}

/** Where a use came from: the run, the genres and the kind of game the plan declared, and when. */
function stampProvenance(
  entry: CatalogueEntry,
  { runId, genres, kind }: { runId: string | null; genres: unknown; kind: string | null },
): void {
  if (runId) entry.runs = [...new Set([...(entry.runs ?? []), runId])].slice(-MAX_ENTRY_RUNS);
  const declared = (Array.isArray(genres) ? genres : []).map((g: unknown) => slug(g, "")).filter(Boolean);
  if (declared.length) entry.genres = [...new Set([...(entry.genres ?? []), ...declared])].slice(0, MAX_ENTRY_GENRES);
  if (kind) entry.kinds = [...new Set([...(entry.kinds ?? []), kind])].slice(0, MAX_ENTRY_GENRES);
  entry.lastUsed = new Date().toISOString();
}
