/**
 * The director's rules: everything the run decides by rule, with no run of its own — the
 * plan and worker specs it compiles, the monitor's findings, the landing sentences, the defect
 * router.
 *
 * The rest of what used to live here has a module of its own, and every name is still exported
 * from here (and `director.ts` re-exports them from here), so a harness file the in-app agent
 * edited before the split keeps its imports: the arguments a tool call carries (args.ts), the
 * budgets and clocks (budgets.ts), the director's memory (memory.ts), the tool schemas
 * (tool-specs.ts), the digests a wait and a status answer with (digests.ts) and the briefs the
 * sessions open with (briefs.ts).
 *
 * It imports no part of the run, so the parts can use it without an import cycle.
 */
import { shortSha } from "../git.ts";
import { Side } from "../judge.ts";
import { GameTrait, isGameKind, KIND_NAMES, normalizePlayScript } from "../kinds.ts";
import { isRunning, WorkerMode } from "../outcomes.ts";
import { parsePlanSteering } from "../replan.ts";
import { allowedFile, mechanicalReview } from "../review.ts";
import { setupVerifyExpr } from "../scout.ts";
import {
  CheckOrigin,
  CheckWeight,
  MoveOwner,
  normalizeFacetSpec,
  normalizeGameTraits,
  validateFacetSpec,
  withHarnessChecks,
  withRequestedStateCheck,
} from "../spec.ts";
import { CLIP_QUOTE, CLIP_REASON, clip } from "../text.ts";
import { Against } from "../verdict.ts";
import { KIND_QUOTED, lines, list, num, parseJson, slug } from "./args.ts";
import { contractRefusalWords } from "./contract-prompts.ts";
import { parseModuleContract, singlePart } from "./module-contract.ts";
import { MAX_LEDGER, MAX_PLAN_WORKERS, PLAN_HOLD_SLICE_MS, SILENT_ROUND_MIN } from "./budgets.ts";
import { SECOND_MS } from "../time.ts";
import { FacetStage, isFinishing } from "../facet/stage.ts";
import { isOpenRung, withOpenRung } from "../facet/growth.ts";
import { scopeItems } from "../scope.ts";
import { SCREEN_CRITIC } from "../screen-owner.ts";
import { parseVision } from "../vision.ts";
import { visionRefusalWords } from "../vision-prompts.ts";
import { NoteKind } from "./wake-schedule.ts";
import type { AnyRecord } from "../../types/harness.d.ts";
import type { Check, FacetSpec } from "../spec.ts";
// Type-only: erased at runtime, so rules.ts still imports no part of the run.
import type { Worker } from "./loop-run.ts";

export { list, namedTitle, num, parseJson, slug, withoutFrames, yes } from "./args.ts";
export {
  CLOSE_SETTLE_MS,
  MAX_WAIT_S,
  MAX_WORKERS,
  medianMinutes,
  MIN_FREE_MB,
  MONITOR_TICK_MS,
  monitorEveryMs,
  planReviewWaitMs,
  preparationBudgetMs,
  SEED,
  shortBudgetWarning,
  timedWorkRemaining,
  WORKER_FLOOR_MS,
  workerWindows,
  wrapReserveMs,
} from "./budgets.ts";
export { contractBrief, directorBrief, singleWorkerBrief, wrapUpPrompt } from "./briefs.ts";
export { clampBoard, iterationDigest, loopDigest, loopNote, waitDigest, workerDigest } from "./digests.ts";
export { clampDirectorMemory, directorMemoryKeep, MAX_DIRECTOR_MEMORY } from "./memory.ts";
export { DIRECTOR_TOOLS, DirectorTool, directors, directorTool, headSynced } from "./tool-specs.ts";
export { minutes } from "../time.ts";

/**
 * How a landing came to be claimed (`landingWords`): a token the screen reads beside the
 * sentence. Reports keep it: never rename a value.
 */
export const LandingHow = {
  JudgePick: "judge-pick",
  /** Nothing to compare it with (a new game, an unseen start): the close's judge found it shows what was asked. */
  JudgeAnsweredYes: "judge-answered-yes",
  /** Nothing to compare it with: the close's judge was sure it does not show what was asked yet. */
  JudgeAnsweredNo: "judge-answered-no",
  FreshHealthPass: "fresh-health-pass",
  JudgeSawLoad: "judge-saw-load",
  NoFreshLook: "no-fresh-look",
  /** Nothing was made live, so there is nothing to claim. */
  NotLanded: "not-landed",
} as const;
export type LandingHow = (typeof LandingHow)[keyof typeof LandingHow];

/** A defect nobody is building any more: on the run's own ledger (`state.ledger`), for the director's next integration. */
export interface ShelvedDefect {
  text: string;
  from: string;
  owner: string;
  at: number;
}

/** Why the plan hold (`waitForPlanGo`) let go: the user's go, their other words, the slice, the window, or the run stopping. */
export const PlanHold = {
  Go: "go",
  Answered: "answered",
  Slice: "slice",
  Window: "window",
  Stopped: "stopped",
} as const;
export type PlanHold = (typeof PlanHold)[keyof typeof PlanHold];

/** How often the plan hold reads the inbox again. */
const PLAN_HOLD_TICK_MS = 2 * SECOND_MS;
/** How many of the files a worker touched a monitor note names. */
const TOUCHED_FILES_NAMED = 6;
/** How much of a plan the user's card carries. */
const PLAN_SUMMARY = 2_000;
const PLAN_BASE = 400;
const PLAN_RISKS = 6;
const PART_TITLE = 80;
const PART_SEAM = 200;
const PART_DONE = 6;
/** How much of a part a refusal quotes. */
const PART_QUOTED = 80;

/**
 * The run's own starting points: the empty scaffold a from-scratch run began on, and the
 * commit its base stage accepted. A blank picture on one of these is the stage's honest output,
 * so every pass that looks at one looks as the harness's base pass (the only pass gauntlet lets
 * off blankness), and the close does not count one as a run's work.
 *
 * The base commit comes back on a resume too: a run killed before any worker merged resumes
 * standing on its own empty base, and a set that had forgotten it refused every worker with
 * "the build does not run" — the failure the base stage exists to prevent.
 */
export function startingHeads({
  fromScratch = false,
  forkCommit = null,
  priorJournal = null,
}: {
  fromScratch?: boolean;
  forkCommit?: string | null;
  priorJournal?: AnyRecord | null;
} = {}): string[] {
  return [
    ...(fromScratch && forkCommit && !priorJournal?.director?.integrationHead ? [forkCommit] : []),
    ...(priorJournal?.base?.ok && priorJournal.base.commit ? [priorJournal.base.commit] : []),
  ];
}

/**
 * What the landing can honestly claim about the build it made live. A health pass says the
 * build loads; only a blind pick over the build the user had says it is better. The first
 * director run landed on "it loaded" and reported "the judge had passed it"; the second could
 * have reported a pick over another worker's dead end — or a yes to any question at all — as
 * the same thing, because nothing recorded what the comparison had been against.
 *
 * A new game, or one whose start nobody could photograph, has nothing to be preferred over: the
 * close asks its judge whether the build shows what the user asked for (integrate.ts
 * `judgeTheLanding`), and only that answer — never a lead's free-text question — is said on the card.
 *
 * `how` is a token for the screen to read; `line` is the sentence the morning card can show.
 */
export function landingWords({
  judged = null,
  healthPassed = false,
}: {
  judged?: {
    pick?: string | null;
    against?: string | null;
    ok?: boolean;
    answer?: boolean | null;
    final?: boolean;
  } | null;
  healthPassed?: boolean;
} = {}): { verified: boolean; how: LandingHow; line: string } {
  // "start" and "live" are both the build the user had: the live folder stays at the base until
  // the landing moves it. A pick over a worker's branch, or a yes to a free-text question, is
  // not that comparison and never sets `verified`.
  const againstTheStart = judged?.against === Against.Start || judged?.against === Against.Live;
  const preferred = Boolean(judged && judged.pick === Side.Challenger && againstTheStart);
  if (preferred) return { verified: true, how: LandingHow.JudgePick, line: "made live, a judge preferred it" };
  const closeAnswered = judged?.final === true && typeof judged.answer === "boolean";
  if (closeAnswered && judged.answer)
    return {
      verified: false,
      how: LandingHow.JudgeAnsweredYes,
      line: "made live, a judge found it does what you asked",
    };
  if (closeAnswered)
    return {
      verified: false,
      how: LandingHow.JudgeAnsweredNo,
      line: "made live, though a judge found it does not do what you asked yet",
    };
  if (healthPassed) return { verified: false, how: LandingHow.FreshHealthPass, line: "made live, not judged better" };
  if (judged?.ok) return { verified: false, how: LandingHow.JudgeSawLoad, line: "made live, not judged better" };
  return { verified: false, how: LandingHow.NoFreshLook, line: "made live, without a fresh look at it" };
}

/**
 * The fallback plain sentence, for a card whose writer gave none: everything only a developer
 * could read — shas, refs, attempt branches, run ids, absolute paths — is taken out and what is
 * left is tidied. A card that can say it better should pass its own sentence instead.
 */
export function plainly(text: unknown): string {
  return (
    String(text ?? "")
      .replace(/\b(?:refs\/|attempt\/)[\w./-]+/g, "")
      .replace(/\/(?:Users|private|var|tmp)\/\S+/g, "")
      .replace(/\brun_[a-z0-9]{6,}\b/gi, "")
      // Eight and up: a word like "defaced" is not a sha, and every sha the cards carry is ten.
      .replace(/\b[0-9a-f]{8,40}\b/g, "")
      .replace(/\(\s*[),;:—–-]*\s*\)/g, "")
      .replace(/\s+([,.;:])/g, "$1")
      .replace(/\s{2,}/g, " ")
      .trim()
      .replace(/[\s—–:,;'"(-]+$/, "")
      // What a removed sha or ref leaves behind: "kept unlanded on", "merged shine at".
      .replace(/\s+(?:on|at|in|to|from|as|of)$/i, "")
      .replace(/[\s—–:,;'"(-]+$/, "")
      .trim()
  );
}

/** One part of a plan, as the harness holds the director to it. */
export interface PlanPart {
  multiplayer?: boolean;
  /** `"mode":"single"`: a part only ever built by one session, not counted as a looping part (module-contract.ts). */
  single?: boolean;
  id: string;
  title: string;
  seam: string;
  owns: string[];
  done: string[];
  minutes: number | null;
  /** A part beyond what the user asked for (scope.ts): in goal mode an optional goal, never required. */
  added?: boolean;
}

/** A field that may be a JSON array or a string of entries, as trimmed, non-empty strings. */
function entries(value: unknown, split: (value: unknown) => string[]): string[] {
  return (Array.isArray(value) ? value.map(String) : split(value)).map((entry: string) => entry.trim()).filter(Boolean);
}

/**
 * What kind of game this is (M4.4). Declared here or nowhere: the board, the play script the
 * harness drives and the line every judge reads all come from it, and nothing is assumed.
 */
function planGame(
  kind: unknown,
  play_script: unknown,
): { game: AnyRecord | null; error?: undefined } | { error: string } {
  const kindName = String(kind ?? "").trim();
  const quoted = kindName.slice(0, KIND_QUOTED);
  if (kindName && !isGameKind(kindName))
    return {
      error: `plan: kind "${quoted}" is not a kind — name one of ${KIND_NAMES.join(", ")}`,
    };
  const parsedScript = parseJson(play_script);
  if (parsedScript?.__error) return { error: `plan: play_script ${parsedScript.__error}` };
  const playScript = normalizePlayScript(parsedScript);
  if (!kindName && !playScript) return { game: null };
  return {
    game: normalizeGameTraits({ ...(kindName ? { kind: kindName } : {}), ...(playScript ? { playScript } : {}) }),
  };
}

/** One part as the director wrote it: a bare id is a part too; everything else about it is optional. */
function planPart(entry: unknown, id: string): PlanPart {
  const raw: AnyRecord = typeof entry === "string" ? { id: entry } : (entry ?? {});
  return {
    id,
    title:
      String(raw.title ?? "")
        .trim()
        .slice(0, PART_TITLE) || id,
    seam: String(raw.seam ?? "")
      .trim()
      .slice(0, PART_SEAM),
    owns: entries(raw.owns, list),
    done: entries(raw.done, lines).slice(0, PART_DONE),
    ...(raw.multiplayer === true ? { multiplayer: true } : {}),
    ...(singlePart(raw) ? { single: true } : {}),
    minutes: Math.round(num(raw.minutes, 0)) || null,
    ...(raw.added === true ? { added: true } : {}),
  };
}

/** The parts a plan names, each with an id and none twice — or the sentence that says what is wrong. */
function planParts(workers: unknown): { parts: PlanPart[]; error?: undefined } | { error: string } {
  const parsed = parseJson(workers);
  if (parsed?.__error) return { error: `plan: workers ${parsed.__error}` };
  if (!Array.isArray(parsed) || !parsed.length) {
    return {
      error: `plan: workers is a JSON array of the parts you mean to hand out — [{"id":"plaza-lighting","title":"Plaza lighting","seam":"the plaza's light","owns":"src/plaza.js","done":["the plaza reads as dusk"],"minutes":45}]`,
    };
  }
  if (parsed.length > MAX_PLAN_WORKERS)
    return {
      error: `plan: ${parsed.length} parts — name at most ${MAX_PLAN_WORKERS}; the run cannot hold them and the user cannot read them`,
    };
  const parts: PlanPart[] = [];
  for (const entry of parsed) {
    const id = slug(typeof entry === "string" ? entry : entry?.id);
    if (!id)
      return {
        error: `plan: every part needs the id you will pass to worker_start (${JSON.stringify(entry ?? null).slice(0, PART_QUOTED)})`,
      };
    if (parts.some((w) => w.id === id)) return { error: `plan: two parts called "${id}"` };
    parts.push(planPart(entry, id));
  }
  return { parts };
}

/**
 * The run's plan, compiled (M3.8). The first director run had none: five workers started at
 * 16:25 on a 900-character decision card and a gitignored file, and the morning's Builds page
 * showed ten parts, half of them red, with no page saying what the run set out to do. The
 * plan is now an object the harness holds the director to — the ids here are the ids
 * `worker_start` is called with — and one card in the user's chat.
 *
 * Pure, and forgiving of everything except what the user would have to read: a summary in
 * plain words and at least one part with an id.
 */
export function compilePlan({
  summary = "",
  workers = null,
  base = "",
  risks = "",
  kind = "",
  play_script = null,
  contract = null,
  vision = null,
  cut = null,
  added = null,
}: {
  summary?: string;
  workers?: unknown;
  base?: string;
  risks?: unknown;
  kind?: string;
  play_script?: unknown;
  /** The module contract (module-contract.ts): who owns which module and what it exposes. */
  contract?: unknown;
  /** The vision (vision.ts): what the world grows toward — scale, the far view, set-pieces, headroom. */
  vision?: unknown;
  /** What this run will not build (scope.ts): joins the run's cut list. */
  cut?: unknown;
  /** What the plan builds beyond the ask: one decision card each, never scope by itself. */
  added?: unknown;
} = {}): { plan: AnyRecord; error?: undefined } | { error: string; plan?: undefined } {
  const text = String(summary ?? "").trim();
  if (!text)
    return { error: "plan: summary is what this run is for, in two or three sentences the user would understand" };
  const declared = planGame(kind, play_script);
  if (declared.error !== undefined) return { error: declared.error };
  const named = planParts(workers);
  if (named.error !== undefined) return { error: named.error };
  const modules = parseModuleContract(
    contract,
    named.parts.map((part) => part.id),
  );
  if (modules.problem !== undefined) return { error: contractRefusalWords(modules.problem) };
  const direction = parseVision(vision);
  if (direction.problem !== undefined) return { error: visionRefusalWords(direction.problem) };
  // Capped like every scope list (scope.ts `scopeItems`); a plan that names neither is what it was.
  const cutItems = scopeItems(cut);
  const addedItems = scopeItems(added);
  return {
    plan: {
      summary: text.slice(0, PLAN_SUMMARY),
      workers: named.parts,
      base: String(base ?? "")
        .trim()
        .slice(0, PLAN_BASE),
      risks: lines(risks).slice(0, PLAN_RISKS),
      game: declared.game,
      ...(modules.contract ? { contract: modules.contract } : {}),
      ...(direction.vision ? { vision: direction.vision } : {}),
      ...(cutItems.length ? { cut: cutItems } : {}),
      ...(addedItems.length ? { added: addedItems } : {}),
    },
  };
}

/**
 * The hold itself: poll what the user has said until they say go, until they say anything else
 * (their words outrank the plan — the director gets them and decides), until this call's slice
 * is up (the bridge carrying the call will not wait forever) or until the window closes, which
 * is the auto-proceed. The clock, the sleep and the reading are handed in so both endings can
 * be tested in milliseconds.
 */
export async function waitForPlanGo({
  until,
  sliceMs = PLAN_HOLD_SLICE_MS,
  read,
  sleep,
  now = () => Date.now(),
  stopped = async () => false,
  tickMs = PLAN_HOLD_TICK_MS,
}: {
  until: number;
  sliceMs?: number;
  read: () => Promise<string[]>;
  sleep: (ms: number) => Promise<unknown>;
  now?: () => number;
  stopped?: () => Promise<boolean>;
  tickMs?: number;
}): Promise<{ go: boolean; said: string[]; reason: PlanHold }> {
  const sliceEnd = now() + sliceMs;
  while (now() < until) {
    if (await stopped()) return { go: false, said: [], reason: PlanHold.Stopped };
    const said = await read();
    if (parsePlanSteering(said.join("\n")).go) return { go: true, said, reason: PlanHold.Go };
    if (said.length) return { go: false, said, reason: PlanHold.Answered };
    if (now() >= sliceEnd) return { go: false, said: [], reason: PlanHold.Slice };
    await sleep(tickMs);
  }
  return { go: false, said: [], reason: PlanHold.Window };
}

/** The file a `git status --porcelain` line names (the destination of a rename). */
function porcelainFile(line: unknown): string {
  const rest = String(line ?? "")
    .slice(3)
    .trim();
  const named = rest.includes(" -> ") ? rest.slice(rest.lastIndexOf(" -> ") + 4) : rest;
  return named.replace(/^"|"$/g, "").trim();
}

/**
 * What one look at a worker's worktree found, mid-turn: the files it has touched and the
 * contract violations a regex can see in them. `status` is `git status --porcelain`, which
 * shows a module the builder has just created — `git diff` alone shows only tracked edits,
 * and a new file outside the worker's own files is exactly the mistake worth catching early.
 */
export function monitorFindings({
  status = "",
  diff = "",
  spec,
  ownsMain = true,
  main = null,
  studio = null,
  template = true,
}: {
  status?: string;
  diff?: string | null;
  spec: AnyRecord & { id: string; owns: string[] };
  ownsMain?: boolean;
  main?: string | null;
  studio?: string | null;
  template?: boolean;
}): { files: string[]; violations: string[] } {
  const files = [...new Set(String(status).split("\n").map(porcelainFile).filter(Boolean))].sort();
  const violations: string[] = [];
  const say = (what: string): void => {
    if (!violations.includes(what)) violations.push(what);
  };
  for (const file of files) {
    if (
      !allowedFile(
        file,
        {
          ...spec,
          ...(main ? { main } : {}),
          ...(studio ? { studio } : {}),
          ...(template === false ? { template: false } : {}),
        },
        ownsMain,
      )
    )
      say(`edited a file outside this facet's ownership (${file})`);
  }
  for (const violation of mechanicalReview(diff, spec, { ownsMain, main, studio, template })) say(violation.what);
  return { files, violations };
}

/**
 * What a look is worth saying out loud. Only a change speaks: the same three violations for
 * half an hour are one note, not ten, and every note that wakes the lead costs it a turn. A
 * round that has written nothing for a quarter of an hour says so once. `kind` says which of
 * them wakes a resting lead: a fresh violation does; its clearing and a silent round only open
 * the next digest.
 */
export function monitorNote(
  before: AnyRecord | null | undefined,
  now: AnyRecord,
): { text: string; kind: NoteKind; silent?: boolean } | null {
  const violations = now.violations ?? [];
  const said = before?.violations ?? [];
  const fresh = violations.filter((v: string) => !said.includes(v));
  const where = `worker ${now.id}: ${now.minutesInRound} min into round ${now.round}`;
  if (fresh.length)
    return {
      text: `${where} — ${fresh.join("; ")}${now.files.length ? ` (touched ${now.files.slice(0, TOUCHED_FILES_NAMED).join(", ")})` : ""}`,
      kind: NoteKind.MonitorViolation,
    };
  if (said.length && !violations.length)
    return { text: `${where} — the contract violations it had are gone`, kind: NoteKind.MonitorQuiet };
  const silentRound =
    !violations.length && !now.files.length && !before?.silentSaid && now.minutesInRound >= SILENT_ROUND_MIN;
  if (silentRound) return { text: `${where} and nothing written yet`, kind: NoteKind.MonitorQuiet, silent: true };
  return null;
}

/**
 * A defect the judge named while looking at one worker, handed to the worker whose seam it is.
 * The facet loop routes through this (`defectsToChecks`, and a builder's own HARNESS flag);
 * with no router every defect became a question on the board of whichever worker happened to
 * be judged — one worker scored on whether another worker's props float, and neither board
 * ever reaching "satisfied". Returning false leaves the defect where it
 * was named, so a worker can never hand itself its own defect, and when the owner is finished
 * there is nobody to take it: it goes on the run's ledger for the director's next integration
 * instead of being dropped (the classic pipeline gives it to the integration facet the same way).
 */
export function makeRouteDefect({
  workers,
  from,
  ledger,
  note,
}: {
  workers: Map<string, Worker>;
  from: string;
  ledger: ShelvedDefect[];
  note: (text: string, kind?: NoteKind) => void;
}): (facetId: unknown, check: Check) => boolean {
  return (facetId, check) => {
    const id = slug(facetId);
    if (!id || id === from) return false;
    const target = workers.get(id);
    if (!target) return false;
    const text = clip(check?.defect ?? check?.ask ?? check?.id ?? "", CLIP_REASON);
    if (!takesDefects(target)) {
      shelveDefect(ledger, { text, from, owner: id });
      const whose = isRunning(target) ? "a single session, no board" : target.state;
      note(
        `worker ${from}: a defect the judge named is worker ${id}'s (${whose}), so nobody is building it — it is on the run's ledger for your next integration: "${text.slice(0, CLIP_QUOTE)}"`,
        NoteKind.DefectShelved,
      );
      return true;
    }
    if (!putOnBoard(target.spec, check)) return true;
    target.steering.push(
      `A judge saw this while judging ${from}, and it is in your files, not theirs: "${text}". It is on your board now as ${check.id} — fix it this iteration.`,
    );
    note(
      `worker ${id}: a defect named while judging ${from} is on its board — "${text.slice(0, CLIP_QUOTE)}"`,
      NoteKind.DefectRouted,
    );
    return true;
  };
}

/** Can this worker take a defect on its board: a loop that is still running, with a spec. */
const takesDefects = (worker: Worker): worker is Worker & { spec: FacetSpec } =>
  isRunning(worker) && worker.mode === WorkerMode.Loop && Boolean(worker.spec);

/** A defect nobody can build now goes on the run's ledger, once, for the director's next integration (art-direction.ts shelves its own here). */
export function shelveDefect(
  ledger: ShelvedDefect[],
  { text, from, owner }: { text: string; from: string; owner: string },
): void {
  if (!text || ledger.some((d) => d.text === text)) return;
  ledger.push({ text, from, owner, at: Date.now() });
  if (ledger.length > MAX_LEDGER) ledger.shift();
}

/** Is this check already on the board, by its id or by the defect it names? */
const alreadyOnBoard = (checks: readonly Check[], check: Check): boolean =>
  checks.some((c) => c.id === check.id || Boolean(c.defect && check.defect && c.defect === check.defect));

/** A camera the check is judged through, when the spec does not look through it yet (the harness's own frames aside). */
function newCamera(spec: AnyRecord, check: Check): string | null {
  const camera = String(check.camera ?? "");
  if (!camera || (spec.cameras ?? []).includes(camera)) return null;
  if (camera.startsWith("eye:") || camera.startsWith("demo:")) return null;
  return camera;
}

/** Put a routed defect's check on a worker's board (and its camera on its spec); false when it was already there (art-direction.ts puts its own here). */
export function putOnBoard(spec: AnyRecord, check: Check): boolean {
  if (!Array.isArray(spec.checks)) spec.checks = [];
  if (alreadyOnBoard(spec.checks, check)) return false;
  spec.checks.push(check);
  const camera = newCamera(spec, check);
  if (camera) spec.cameras = [...(spec.cameras ?? []), camera];
  return true;
}

/** What the director typed for a worker, as `compileWorkerSpec` compiles it. */
export interface WorkerSpecInput {
  id: string;
  title?: string;
  brief?: string;
  owns?: string[];
  identity?: string[];
  cameras?: string[];
  checks?: unknown[];
  done?: unknown[];
  milestones?: unknown[];
  traits?: string[];
  kind?: string | null;
  /** Which critic reviews this part (`place` or `screen`); absent, its kind's. */
  critic?: string | null;
  ownsMain?: boolean;
  setup?: AnyRecord | null;
  screen?: boolean;
  index?: number;
  forkedFrom?: string | null;
  /** "finish" for a worker that finishes what exists (facet/stage.ts); absent or anything else, the build stage. */
  stage?: string | null;
}

/**
 * The harness's own checks for the kind and the traits the director named. Only what it named: a
 * trait it did not mention is not declared false — it is simply not declared, and the kind (the
 * run's, unless this part differs) decides. The front-end's owner (`keepsFrontEnd`) is judged on
 * its menu, so the checks that only hold in play stay off its board.
 */
function withDeclaredGame<S extends FacetSpec>(
  spec: S,
  {
    kind,
    traits,
    ownsMain,
    screen,
    keepsFrontEnd,
  }: { kind: string | null; traits: string[]; ownsMain: boolean; screen: boolean; keepsFrontEnd: boolean },
): S {
  const kindName = isGameKind(kind) ? kind : null;
  if (!kindName && !traits.length) return spec;
  const declared: AnyRecord = { ...(kindName ? { kind: kindName } : {}) };
  for (const trait of Object.values(GameTrait)) if (traits.includes(trait)) declared[trait] = true;
  return withHarnessChecks(spec, { ownsMain, game: normalizeGameTraits(declared), screen, keepsFrontEnd });
}

/**
 * The part's own critic, when the director named one. The part reviewed as a screen owns it
 * (loop/screen-owner.ts): every other part publishes its values and never draws them.
 */
function withCritic(spec: FacetSpec, critic: string | null): void {
  if (!critic) return;
  spec.critic = critic;
  if (critic === SCREEN_CRITIC) spec.ownsScreen = true;
}

/** What the dry run could not do when nothing in this run has looked at the fork point yet. */
function notVerifiedWords(base: AnyRecord | null, forkedFrom: string | null): string | null {
  if (base) return null;
  const where = forkedFrom ? shortSha(forkedFrom) : "the fork point";
  return `nothing has looked at ${where} in this run, so its checks were not read against the state it reports — judge it, or read the first iteration's board closely`;
}

/**
 * The worker's contract, compiled from what the director typed: `done` and `checks` normalised
 * into one spec, the prose `identity` features turned into weights, the harness's own checks
 * and the requested-state probe added, everything validated — and then read once against the
 * state the fork point actually reports (`base`, cached by whoever last looked at that commit).
 *
 * The dry run is the difference between a contract and a wish. The first director run wrote
 * thirteen probes over `state.<facet>.<field>`, started five workers on them and read
 * `missing: …` on every board for six hours. Here a path the build does not report comes back
 * as `unsatisfiable` with the keys it does have, and rides into the builder's brief as a note.
 * Nothing is refused for it: a path the build must start reporting is a legitimate contract,
 * and a fork nobody has looked at yet simply reports `notVerified`.
 *
 * `rarelyMeasurable` is the other half of the same warning, and it comes from the game's own
 * ledger rather than from one commit: a check that came back unmeasured on three or more rounds
 * of this kind of game has never told anybody anything, whatever the fork point happens to
 * report today. It is a warning, never a refusal — the honest fix is the director's.
 */
export function compileWorkerSpec(
  {
    id,
    title = "",
    brief = "",
    owns = [],
    identity = [],
    cameras = [],
    checks = [],
    done = [],
    milestones = [],
    traits = [],
    kind = null,
    critic = null,
    ownsMain = true,
    setup = null,
    screen = true,
    index = 0,
    forkedFrom = null,
    stage = null,
  }: WorkerSpecInput,
  base: AnyRecord | null = null,
  { rarelyMeasurable: rarely = [] }: { rarelyMeasurable?: Array<{ id: string; rounds: number }> } = {},
) {
  // The lead's own `{"open":true}` says where it leaves the ladder open; the harness puts the one
  // open rung at the end below, whatever the lead wrote.
  const rungs = milestones.filter((rung) => !isOpenRung(rung));
  let spec = normalizeFacetSpec(
    { id, title: title || id, intent: brief, owns, identity, cameras, checks, done, milestones: rungs, budgetShare: 0 },
    index,
  );
  spec = withDeclaredGame(spec, { kind, traits, ownsMain, screen, keepsFrontEnd: setup?.begin === false });
  const expr = setupVerifyExpr(setup?.verify);
  if (expr) spec = withRequestedStateCheck(spec, { expr, note: setup?.note ?? "" });
  // Before validation: a screen part's board may be mostly vision (spec.ts visionHeavy).
  if (critic) spec.critic = critic;
  const validated = validateFacetSpec(spec, {
    state: base?.state ?? null,
    demoStates: base?.demoStates ?? null,
    demos: base?.demos ?? null,
    cameras: base?.cameras ?? null,
  });
  spec = validated.spec ?? spec;
  spec.setup = setup;
  withCritic(spec, critic);
  // Who owns the move (M3.3). A director that wrote a ladder owns it: the harness hands the
  // worker the next unclimbed rung and never puts a move of its own ahead of one — the planner's
  // "the ONE structural move" and the liveness critic's grow gaps once overruled a brief every
  // iteration. The ladder ends with an open rung (facet/growth.ts): the reviewers' best step inside
  // the ask fills it when it is reached, so growth the lead did not foresee still has a way in.
  // With no ladder the harness names the move as it always did.
  if (spec.milestones?.length) {
    spec.milestones = withOpenRung(spec.milestones);
    spec.moveOwner = MoveOwner.Director;
  }
  // The finish stage rides on the spec beside moveOwner: the loop fixes it at the top of each
  // round, a steer flips it from the next one, and the run log records a steer. A build worker's
  // spec carries no stage at all.
  if (isFinishing({ stage })) spec.stage = FacetStage.Finish;
  return {
    spec,
    problems: validated.problems ?? [],
    unsatisfiable: validated.unsatisfiable ?? [],
    stateKeys: validated.stateKeys ?? null,
    identityTotal: spec.checks.filter((c) => c.weight === CheckWeight.Identity).length,
    notVerified: notVerifiedWords(base, forkedFrom),
    // The harness's own checks are not the director's to re-point or drop.
    rarelyMeasurable: (rarely ?? [])
      .filter((entry) => spec.checks.some((check) => check.id === entry.id && check.origin !== CheckOrigin.Harness))
      .map((entry) => ({ id: entry.id, rounds: entry.rounds })),
  };
}
