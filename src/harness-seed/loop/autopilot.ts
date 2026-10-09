/**
 * Autopilot — the orchestrator (AUTOPILOT-PLAN.md §6.2, reworked per HARNESS-REWORK.md §4.5).
 *
 * interview (already happened, in chat) → decompose into typed specs → base builder (the
 * shared commit every facet forks from) → facet loops through the scheduler, continuously
 * merged into a run-level integration branch → integration facet (the merged build gets its
 * own scoreboard and iterations) → global verdict against the base, not the scaffold → close.
 * One facet is the degenerate case and IS the existing gauntlet — same events, same rules.
 *
 * Topology is identical on every engine (A7); the only local-vs-cloud difference is
 * `concurrencyProfile`: delegated/cloud engines run facets in parallel worktrees, a direct
 * local engine runs the same facets sequentially against the live folder, because a 30 tok/s
 * GPU is saturated by one stream.
 */
import { runGauntlet } from "./gauntlet.ts";
import { gatherEvidence, observationOnlyFailure } from "./evidence.ts";
import { runFacetLoop } from "./facet-loop.ts";
import { runOptimization, skipOptimization } from "./optimization.ts";
import { optimizationAllowance } from "./performance.ts";
import { buildTurn } from "./build-turn.ts";
import { blindCompare, judgeAgainstReference, parseVerdict, referenceStats } from "./judge.ts";
import { EngineId, plannerModel, roleEffort, roleEngine, RoleKey, supportsSessions } from "./model-roles.ts";
import {
  CheckKind,
  CheckOrigin,
  CheckWeight,
  expandCheckGrammar,
  loadCatalogue,
  normalizeFacetSpec,
  normalizeGameTraits,
  recordCatalogueOutcomes,
  renderCatalogueForPlanner,
  renderCheckGrammar,
  saveCatalogue,
  validateFacetSpec,
  withHarnessChecks,
  withRequestedStateCheck,
  withStyleMetric,
} from "./spec.ts";
import { learningOn } from "./learning.ts";
import { renderScoutForPlanner, runScout, setupVerifyExpr } from "./scout.ts";
import { KIND_NAMES, readDeclaredGame, writeDeclaredGame } from "./kinds.ts";
import * as library from "./library.ts";
import { renderScoreboard, summarizeScoreboard } from "./checks.ts";
import { bestStyleDistance } from "./style.ts";
import { EngineFailure, outageDelays, withProviderPatience } from "./outage.ts";
import { unionMergeMain } from "./merge.ts";
import { parsePlanSteering } from "./replan.ts";
import { createRunInbox } from "./run-inbox.ts";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isCommit } from "./shell.ts";
import { GIT, commitAll, gitExec, headOf, isAncestor, landIntegration, mergeNoFf, shortFailure } from "./git.ts";
import {
  DEFAULT_WALL_CLOCK_MS,
  GIT_TIMEOUT_MS,
  MIN_DELEGATE_TIMEOUT_MS,
  PAGE_SEED,
  PLAN_REVIEW_WAIT_MS,
} from "./config.ts";
import { diedEarly, OptimizationOutcome, StopCode, stopWith } from "./outcomes.ts";
import { baseBrief, contractWiringAsk } from "./prompts-build.ts";
import { integratorBrief } from "./autopilot-prompts.ts";
import { HostMethod } from "./host-methods.ts";
import {
  appendRun as appendRunEvent,
  EventKind,
  JournalPhase,
  REFERENCE_MIN_STILLS,
  ReferenceKind,
  RunEvent,
  RunMode,
  saveJournal as saveRunJournal,
} from "./run-events.ts";
import { readJournal, writeJournal } from "./run-journal.ts";
import { clip, CLIP_DETAIL, CLIP_REASON } from "./text.ts";
import { MINUTE_MS, SECOND_MS, sleep } from "./time.ts";
import { isPlainRecord } from "./json.ts";
import { noteHudUpgrade } from "./held-hud.ts";
import { keptContractWords } from "./contract-kept.ts";
import type { AnyRecord, HarnessCtx, Run } from "../types/harness.d.ts";
import type { CompleteResponse, EngineDescriptor, Message, SnapshotRecord } from "../types/host-api.d.ts";
import type { ScoutReport } from "./scout.ts";
import type { Catalogue, Check } from "./spec.ts";

/**
 * The classic run's state, phase to phase: its arguments (ctx, threadId, run, resume), then what
 * each phase sets up for the phases after it (the journal, the report, the integration head, …).
 */
type Pipeline = AnyRecord;
/** What a phase answers: `{ value }` ends the run with that result; nothing hands on. */
type PipelineEnd = { value: unknown } | undefined | void;

/** Headless previews a delegated run assumes when the studio does not say (WP6). */
/** Why a run closes when its global judge gave no usable verdict. */
const GLOBAL_JUDGE_UNUSABLE = "the judge replied three times without a usable verdict";
const DEFAULT_PREVIEW_POOL = 6;
/** How many facets build at once on a delegated engine when the plan's size is not known yet. */
const DEFAULT_PARALLEL = 3;
/** Round one of the fair share: every facet gets this share of its iteration budget before anyone gets more. */
const FAIR_SHARE_FRACTION = 0.5;
/** The integration facet's play check needs this long even at the deadline (WP6). */
const INTEGRATION_PLAY_RESERVE_MS = 6 * MINUTE_MS;
/** How long a plan review waits for steering before building anyway (WP7): config.ts, shared with the director. */
export { PLAN_REVIEW_WAIT_MS };
/** How often a plan review looks for the user's steering. */
const PLAN_STEERING_POLL_MS = 2 * SECOND_MS;
/** The longest the base builder gets, however much of the run is left. */
const BASE_BUILD_TIMEOUT_MS = 45 * MINUTE_MS;
/** The share of the run's clock kept after the facets for integrating and judging them. */
const FACETS_CLOSE_SHARE = 0.15;
/** A run's iteration budget when its spec names none, split across the facets by share. */
const DEFAULT_MAX_ITERATIONS = 60;
/** No facet gets fewer iterations than this (nor a smaller round-one cap). */
const MIN_FACET_ITERATIONS = 3;
/** A facet's own clock in round one, on a live folder: never less than this… */
const MIN_FIRST_ROUND_MS = 10 * MINUTE_MS;
/** …and this share of its budget share of the run. */
const FIRST_ROUND_CLOCK_SHARE = 0.85;
/** A facet's clock in round two, on a live folder, is never less than this. */
const MIN_SECOND_ROUND_MS = 5 * MINUTE_MS;
/** The integration facet runs only with this much of the clock left (or this share of a short run). */
const MIN_INTEGRATION_MS = 2 * MINUTE_MS;
const INTEGRATION_CLOCK_SHARE = 0.1;
/** The integration facet's share of the run's iteration budget. */
const INTEGRATION_ITERATION_SHARE = 0.12;
/** How many times the planner is asked: once, and once more with the problems. */
const PLANNER_ATTEMPTS = 2;
/** The most facets a plan keeps. */
const MAX_PLAN_FACETS = 6;
/** How many reference stills a run loads from the project's references/ folder, and their size. */
const MAX_REFERENCE_STILLS = 12;
const REFERENCE_MAX_PX = 1024;

/** How long the inherited-console read waits for the game to say it is up, and how often it asks. */
const INHERITED_SETTLE_MS = 6 * SECOND_MS;
const STUDIO_UP_POLL_MS = 500;
/** The beat after the game is up: its first shader error is logged a frame later. */
const INHERITED_BEAT_MS = 1.2 * SECOND_MS;

/** The facet a one-facet plan builds: the whole goal. */
const WHOLE_GAME_FACET = "whole-game";
/** The facet the merged build gets (its journal entry, worktree, thread and role). */
const INTEGRATION_FACET = "integration";
/** The base builder's facet id, capture label and build phase. */
const BASE_FACET = "base";
/** The preview a ledger judgement borrows. */
const LEDGER_LABEL = "ledger";
/** How much of the goal a one-facet plan's title keeps. */
const FACET_TITLE_CHARS = 60;
/** What a plan keeps: its assumptions, the unusable checks its note names, the base's notes and files, and its genres. */
const MAX_ASSUMPTIONS = 8;
const DROPPED_CHECKS_NAMED = 3;
const BASE_NOTES_CHARS = 2_000;
const MAX_BASE_FILES = 12;
const MAX_GENRES = 4;
/** A whole-game facet folded from several: its checks, identity features, cameras and milestones. */
const MAX_WHOLE_GAME_CHECKS = 14;
const WHOLE_GAME_IDENTITY = 6;
const WHOLE_GAME_CAMERAS = 8;
const WHOLE_GAME_MILESTONES = 5;
/** The integration facet's identity features and cameras, gathered from every facet. */
const INTEGRATION_IDENTITY = 8;
const INTEGRATION_CAMERAS = 10;
/** The merged build's problems its record keeps, and the ledger defects the integration facet starts with. */
const MERGED_PROBLEMS_KEPT = 5;
const MAX_INITIAL_DEFECTS = 24;
/** The iteration id of the run's last evidence pass. */
const FINAL_ITERATION = "final";
/** The iteration id the optimization pass is judged under. */
const OPTIMIZATION_ITERATION = "optimization-final";
/** The blind judge's pick for the build under test. */
const VERDICT_CHALLENGER = "challenger";
/** What a facet or a run that the user stopped says. */
const STOPPED_BY_USER = "stopped by the user";

/**
 * Record why the run stopped: the code beside the sentence (outcomes.ts `stopWith`), which the
 * run's close carries on `run_finished`. A kept `outcomes.ts` from before a code existed has no
 * such member, and the run then keeps its sentence alone rather than failing on the code.
 */
function stopRun(report: AnyRecord, code: StopCode | undefined, text: string): void {
  if (code) stopWith(report, code, text);
  else report.stoppedBecause = text;
}

/** `stopRun`, unless something already said why the run stopped. */
function stopRunUnlessStopped(report: AnyRecord, code: StopCode | undefined, text: string): void {
  if (!report.stoppedBecause) stopRun(report, code, text);
}

/** Where a finalization came from: the one-facet gauntlet, or the multi-facet pipeline. Journaled. */
const FinalizationOrigin = {
  Single: "autopilot_single",
  Multi: "autopilot_multi",
} as const;

/** Which judgement a provider outage held up (`autopilot_provider_outage`). */
const OutagePhase = {
  Plan: "plan",
  Ledger: "ledger",
  Final: "final",
  Panel: "panel",
} as const;

/**
 * Who said what kind of game this is (`gameFrom` on the plan): the scout that drove it, the
 * user's studio.json, or the plan's own declaration. Journaled with the plan: never rename a value.
 */
const GameSource = {
  Scout: "scout",
  StudioJson: "studio.json",
  Plan: "plan",
} as const;
type GameSource = (typeof GameSource)[keyof typeof GameSource];

/** The NOTES.md heading under which steering that arrived too late to be built is kept. */
const STEERING_BACKLOG_HEADING = "## Steering backlog";

/** The unapplied steering of earlier runs, from the project's NOTES.md; empty when none. */
export function parseSteeringBacklog(notes: unknown): string[] {
  const text = String(notes ?? "");
  const start = text.indexOf(STEERING_BACKLOG_HEADING);
  if (start < 0) return [];
  const body = text.slice(start + STEERING_BACKLOG_HEADING.length);
  const end = body.search(/\n## /);
  return (end >= 0 ? body.slice(0, end) : body)
    .split("\n")
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter((line) => line && !line.startsWith("#"));
}

/**
 * How many facets build at once. A direct local engine is one stream; a delegated engine runs
 * as many facets as the preview pool can observe (WP6: three slots starved facets four and
 * five of a five-facet run). Without a facet count the old default of three stands.
 */
export function concurrencyProfile(
  described: readonly EngineDescriptor[],
  engineId: string | null | undefined,
  { facets = null, previewPoolMax = null }: { facets?: number | null; previewPoolMax?: number | null } = {},
): { maxParallel: number; delegated: boolean } {
  const engine = described.find((e) => e.id === (engineId ?? EngineId.Ollama));
  const delegated = supportsSessions(engine);
  if (!delegated || engine?.kind === "direct") return { maxParallel: 1, delegated };
  const pool = typeof previewPoolMax === "number" && previewPoolMax > 0 ? previewPoolMax : DEFAULT_PREVIEW_POOL;
  const maxParallel = typeof facets === "number" && facets > 0 ? Math.max(1, Math.min(pool, facets)) : DEFAULT_PARALLEL;
  return { maxParallel, delegated };
}

/**
 * What the game already logged when the studio opened it, before anyone in this run touched it.
 * Every pass forgives these, so a shader warning that was in the game when the run began never
 * throws the whole merge away at the last gate.
 *
 * `preview.load` resolves at did-finish-load: before the first frame, before a shader compiles.
 * Read on the next line, the baseline came back empty for exactly the deferred error it exists
 * to forgive, and the base pass then voided the build for inheriting it. So: wait for the game
 * to say it is up (or a short beat, when it never does), then read.
 */
export async function inheritedConsoleAfterLoad(
  ctx: HarnessCtx,
  {
    handle = null,
    settleMs = INHERITED_SETTLE_MS,
    beatMs = INHERITED_BEAT_MS,
  }: { handle?: string | null; settleMs?: number; beatMs?: number } = {},
): Promise<string[]> {
  const h = handle ? { handle } : {};
  const until = Date.now() + settleMs;
  for (;;) {
    const up = await ctx
      .call(HostMethod.PreviewEvaluate, { expression: "Boolean(window.__studio)", ...h })
      .catch(() => null);
    if (up || Date.now() >= until) break;
    await sleep(STUDIO_UP_POLL_MS);
  }
  // Even a game that is up logs its first shader error a frame later.
  await sleep(beatMs);
  return ((await ctx.call(HostMethod.PreviewConsole, { sinceMs: 0, ...h }).catch(() => [])) ?? [])
    .filter((entry: AnyRecord | null) => entry?.level === "error")
    .map((entry: AnyRecord) => String(entry.message));
}

/**
 * ~15 lines of semaphore — the whole local-vs-cloud scheduling difference (A7). A failure stops
 * new items from starting and is thrown once the ones already running have settled: rejecting at
 * once left their facets building behind a run that had moved on.
 */
export async function schedule<T, R>(
  items: readonly T[],
  maxParallel: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const failed: { error?: unknown; yes: boolean } = { yes: false };
  const worker = async () => {
    while (!failed.yes && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        if (!failed.yes) Object.assign(failed, { yes: true, error });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(maxParallel, items.length)) }, worker));
  if (failed.yes) throw failed.error;
  return results;
}

/** A plain async mutex for facets that share the one live observation port. */
export function makeLock(): () => Promise<() => void> {
  let tail: Promise<unknown> = Promise.resolve();
  return () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const turn = tail.then(() => release);
    tail = tail.then(() => held);
    return turn; // awaits prior holders, resolves to this holder's release()
  };
}

/**
 * What the plan says the game IS (M4.4). One kind from the table in kinds.ts; the three traits
 * the harness adds its own checks for are named in the explanation below and left OUT of the
 * shape, because a planner copies this line as it stands. Printed as `"hud":false,
 * "mouseLook":false,"keyboardMove":false` they were copied through as declarations, and an
 * explicit false outranks the kind's own traits — so a first-person game arrived declaring it
 * has no HUD, no mouse look and no keyboard movement, and the four harness-owned checks that
 * kind exists to bring were dropped from every board with nothing said. Absent, each trait
 * takes the declared kind's own value; a plan that declares no kind is still assumed nothing.
 */
const GAME_DECLARATION = `"game":{"kind":"<one of ${KIND_NAMES.join(", ")}, or null>","playScript":null}`;

/** The same declaration, said in words, for the planner that reads the shape line above. */
const GAME_EXPLANATION =
  "`genres` names the genre groups of the catalogue that apply (what the run learns is filed under them); `game` declares what the game IS — its `kind` (one of the names above). The kind carries whether the game has a HUD, mouse look and keyboard movement; add the booleans `hud`, `mouseLook`, `keyboardMove` beside it ONLY where this game differs from its kind, and remember that `false` is a declaration too — it takes that check off every board. With no kind and no trait nothing is assumed: the harness adds its own checks only for what the game can pass, and drives that kind's play script before every judgement. `playScript` overrides that script with your own actions; `craft` names the craft recipe packs this game needs.";

/**
 * The check vocabulary, for a planner whose skill file predates typed specs (an install whose
 * SkillOpt-edited copy the seed upgrader rightly keeps). The skill's SLOW_UPDATE region is the
 * source of truth; this is the fallback that keeps v2 from silently degrading to prose plans.
 */
const V2_SCHEMA_FALLBACK = [
  "",
  "## Typed specs (v2 — this overrides any older output shape above)",
  `Output JSON only: {"genres":["fps"],${GAME_DECLARATION},"craft":[],"facets":[{"id","title","intent","owns":[],"identity":[],"cameras":[],"checks":[…],"budgetShare"}],"mainOwner":"…","base":{"notes":"","files":[{"path","purpose"}]},"integrationNotes":"","assumptions":[]}`,
  "Every facet has `intent` (the prose brief) AND 4–10 `checks`, most of them mechanical:",
  // One grammar (M4.8a). The fallback deliberately omits `metric`: this path has no reference
  // stills behind it, and a kind the planner writes with no evaluator underneath is a check
  // nobody scores.
  renderCheckGrammar({
    kinds: [CheckKind.Scene, CheckKind.Pixel, CheckKind.Probe, CheckKind.Demo, CheckKind.Vision, CheckKind.Play],
    helpers: false,
  }),
  'Mark 2–4 checks per facet weight:"identity"; hard:true for techniques known to need a spike. eye:spawn, eye:here, eye:down, eye:back are harness-owned cameras.',
  GAME_EXPLANATION,
].join("\n");

/**
 * The probe grammar, in the ask itself. The planner's skill file is the workspace's own and may
 * be an older vintage (SkillOpt grows it, and a seed upgrade keeps a self-edited copy), so the
 * two things a probe cannot be written without ride here, where every install reads them.
 */
const PROBE_GRAMMAR = ["PROBES:", renderCheckGrammar({ kinds: [CheckKind.Probe], helpers: true })].join("\n");

const PLAN_SHAPE = `Output JSON only: {"genres":["<genre>"],${GAME_DECLARATION},"craft":[],"facets":[{"id","title","intent","owns":[],"identity":[],"cameras":[],"checks":[{"id","kind","weight","hard",…}],"milestones":[{"id","what","check":{…}|null}],"budgetShare"}],"mainOwner":"<facet id>","base":{"notes":"","files":[{"path","purpose"}]},"integrationNotes":"","assumptions":[]}`;

/**
 * Turn the ask into a facet plan of typed specs with the trainable planner skill and the check
 * catalogue. A plan whose checks do not validate is sent back once with the problems; what is
 * still unusable after that is dropped, never a crash — and a plan that cannot be parsed at all
 * degrades to one facet, the degenerate path.
 */
export async function decompose(
  ctx: HarnessCtx,
  {
    run,
    profile,
    scout = null,
    storedGame = null,
    ownShape = false,
  }: { run: Run; profile: AnyRecord; scout?: AnyRecord | null; storedGame?: AnyRecord | null; ownShape?: boolean },
): Promise<AnyRecord> {
  const known = knownGameOf(scout, storedGame);
  const skill = await readPlannerSkill(ctx);
  const catalogue = await loadCatalogue(ctx.workspace);
  const catalogueText = renderCatalogueForPlanner(catalogue, { game: known.game, screen: !ownShape });
  // The craft recipes as a menu (M4.7): technique, not law — the planner picks the packs this
  // game needs. An install whose library predates them simply gets nothing.
  const craftRecipes = await library.loadRecipes(ctx.workspace).catch(() => []);
  const backlog = await previousSteering(ctx, run);
  const single = singleFacetPlan(run, known);
  const activePlugins = await ctx.call(HostMethod.PluginsTools, {}).catch(() => ({ guidance: "" }));
  const ask = plannerAsk({
    run,
    profile,
    scout,
    backlog,
    guidance: activePlugins.guidance,
    catalogueText,
    craftText: craftMenu(craftRecipes),
  });
  try {
    const { raw, facets, validation } = await askForFacets(plannerCall(ctx, run, skill), ask, craftRecipes);
    if (facets.length === 0) return single;
    return finishPlan({ raw, facets, validation, scout, run, known });
  } catch {
    return single;
  }
}

/** The craft recipe packs the library offers the planner. */
type CraftRecipes = Awaited<ReturnType<typeof library.loadRecipes>>;

/** What kind of game this is before the planner answers, and who said so. */
interface KnownGame {
  game: AnyRecord | null;
  from: GameSource | null;
}

/**
 * What kind of game this is, as far as anyone knows BEFORE the planner answers: the scout
 * drove it, or studio.json says. The catalogue and the craft menus are gated on that — the
 * plan's own declaration arrives too late to choose what the planner is offered.
 */
function knownGameOf(scout: AnyRecord | null, storedGame: AnyRecord | null): KnownGame {
  const scoutSawIt = scout?.kind || scout?.play?.length;
  if (scout && scoutSawIt) {
    const game = normalizeGameTraits({
      ...(scout.kind ? { kind: scout.kind } : {}),
      ...(scout.play ? { playScript: scout.play } : {}),
    });
    return { game, from: GameSource.Scout };
  }
  if (storedGame) return { game: normalizeGameTraits(storedGame), from: GameSource.StudioJson };
  return { game: null, from: null };
}

/**
 * The planner's skill. One grammar (M4.8a): the shipped skill carries `{{check-grammar}}` where
 * its own copy of the check shapes used to be. A workspace whose SkillOpt-edited copy predates
 * the marker comes back unchanged — which is why this is a replace and never an assertion.
 */
async function readPlannerSkill(ctx: HarnessCtx): Promise<string> {
  try {
    return expandCheckGrammar(await readFile(path.join(ctx.workspace, "skills", "facet-decomposition.md"), "utf8"));
  } catch {
    return "";
  }
}

/** The craft packs as the planner's menu; nothing when the library cannot render one. */
function craftMenu(craftRecipes: CraftRecipes): string {
  if (typeof library.renderCraftForPlanner !== "function") return "";
  try {
    return library.renderCraftForPlanner(craftRecipes, {}) ?? "";
  } catch {
    return "";
  }
}

/**
 * Steering the previous run could not build (it arrived with no iteration left) is not
 * lost: it heads the planner's ask so the plan starts from it.
 */
async function previousSteering(ctx: HarnessCtx, run: Run): Promise<string[]> {
  try {
    const games = await ctx.call(HostMethod.GameList, {});
    const dir = games.find((g) => g.name === run.project)?.dir;
    if (!dir) return [];
    return parseSteeringBacklog(await readFile(path.join(dir, "NOTES.md"), "utf8").catch(() => ""));
  } catch {
    return [];
  }
}

/** The degenerate plan: one facet for the whole goal. */
function singleFacetPlan(run: Run, known: KnownGame): AnyRecord {
  return {
    facets: [
      normalizeFacetSpec(
        { id: WHOLE_GAME_FACET, title: run.goal.slice(0, FACET_TITLE_CHARS), intent: run.goal, budgetShare: 1 },
        0,
      ),
    ],
    mainOwner: WHOLE_GAME_FACET,
    base: null,
    integrationNotes: "",
    assumptions: [],
    validation: [],
    genres: [],
    game: known.game,
    gameFrom: known.from,
  };
}

/** The planner's ask: the backlog, the goal and its references, the scout, the menus and the shape. */
function plannerAsk({
  run,
  profile,
  scout,
  backlog,
  guidance,
  catalogueText,
  craftText,
}: {
  run: Run;
  profile: AnyRecord;
  scout: AnyRecord | null;
  backlog: string[];
  guidance: string | undefined;
  catalogueText: string;
  craftText: string;
}): string {
  return [
    backlog.length
      ? `USER STEERING FROM THE PREVIOUS RUN (arrived too late to be built — plan for it now):\n${backlog.map((b) => `- ${b}`).join("\n")}`
      : "",
    `GOAL: ${run.goal}`,
    run.reference?.name ? `REFERENCE / DIRECTION: ${run.reference.name}` : "",
    run.reference?.notes ? `NOTES: ${run.reference.notes}` : "",
    renderScoutForPlanner(scout as ScoutReport | null),
    `ENGINE HINT: maxParallel ${profile.maxParallel}${profile.delegated ? " (parallel contractors; a pool size, not a target)" : " (one local model — 2-3 facets max)"}`,
    `ASSET TOOLS: follow enabled plugin asset preferences and explicit user choices. Include useful generated assets in the plan when appropriate; execution checks account readiness. Procedural assets remain valid where suitable.`,
    guidance,
    `Attached reference stills: ${run.reference?.frames?.length ?? 0}`,
    catalogueText,
    craftText,
    "",
    PROBE_GRAMMAR,
    PLAN_SHAPE,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * One call to the planner. The planner is orchestrator work: it runs on the run's planner role
 * (Fable on Claude Code), not on the builders' model.
 */
function plannerCall(ctx: HarnessCtx, run: Run, skill: string): (messages: Message[]) => Promise<CompleteResponse> {
  const plannerPick = plannerModel(run);
  const systemPrompt =
    (skill ||
      `Decompose the ask into 1-4 independently buildable facets, each with 4-10 verifiable checks. ${PLAN_SHAPE}`) +
    (/"checks"/.test(skill) ? "" : V2_SCHEMA_FALLBACK);
  return (messages) =>
    withProviderPatience(
      ctx,
      () =>
        ctx.call(HostMethod.EngineComplete, {
          engine: run.engine ?? EngineId.Ollama,
          ...(plannerPick ? { model: plannerPick } : {}),
          stream: false,
          // The planner writes every facet's spec once — it thinks at the run's own effort.
          effort: roleEffort(run, RoleKey.Planner),
          preferences: run.preferences,
          systemPrompt,
          messages,
        }),
      {
        delays: outageDelays(run),
        label: "the planner's engine",
        onWait: (w) => providerOutage(ctx, run, { phase: "plan", ...w }),
      },
    );
}

/** What the planner answered: its JSON, the usable facets, and what was wrong with the rest. */
interface PlannerAnswer {
  raw: AnyRecord | null;
  facets: AnyRecord[];
  validation: string[];
}

/** Ask the planner for facets; a plan with problems is sent back once with the exact problems. */
async function askForFacets(
  complete: (messages: Message[]) => Promise<CompleteResponse>,
  ask: string,
  craftRecipes: CraftRecipes,
): Promise<PlannerAnswer> {
  const messages: Message[] = [{ role: "user", content: ask }];
  let answer: PlannerAnswer = { raw: null, facets: [], validation: [] };
  for (let attempt = 0; attempt < PLANNER_ATTEMPTS; attempt++) {
    const response = await complete(messages);
    const text = response.message?.content ?? "";
    answer = readPlannerAnswer(text, craftRecipes);
    if (answer.facets.length === 0) break;
    const missingChecks = answer.facets.filter((f) => f.checks.length === 0).map((f) => f.id);
    if (answer.validation.length === 0 && missingChecks.length === 0) break;
    if (attempt > 0) continue;
    // One re-ask, with the exact problems: the planner corrects its own JSON.
    messages.push({ role: "assistant", content: text });
    messages.push({ role: "user", content: planProblems(answer.validation, missingChecks) });
  }
  return answer;
}

/** The facets in one planner reply, each validated and given the craft checks it asked for. */
function readPlannerAnswer(text: string, craftRecipes: CraftRecipes): PlannerAnswer {
  const raw = parseVerdict(text);
  const listed = Array.isArray(raw?.facets) ? raw.facets : [];
  const normalized = listed
    .filter((f) => f && typeof (f.intent ?? f.brief) === "string" && String(f.intent ?? f.brief).trim())
    .slice(0, MAX_PLAN_FACETS)
    .map((f, i) => normalizeFacetSpec(f, i));
  const validation: string[] = [];
  const facets: AnyRecord[] = [];
  for (const spec of normalized) {
    const checked = validateFacetSpec(spec);
    // The craft a facet asked for by name becomes checks on its board (M4.7). An id that is
    // neither a recipe nor a craft check is a problem the one re-ask can correct, so it is
    // resolved here rather than after the loop.
    const craft =
      typeof library.withCraftChecks === "function"
        ? library.withCraftChecks(checked.spec, craftRecipes)
        : { spec: checked.spec, unknown: [] };
    validation.push(
      ...checked.problems,
      ...craft.unknown.map(
        (id) =>
          `facet ${spec.id}: craft "${id}" is not a recipe id or a craft check id — pick one from the craft menu, or drop it`,
      ),
    );
    facets.push(craft.spec);
  }
  return { raw, facets, validation };
}

function planProblems(validation: readonly string[], missingChecks: readonly string[]): string {
  return [
    "Your plan has problems. Output the corrected JSON only:",
    ...validation.map((p) => `- ${p}`),
    ...missingChecks.map(
      (id) => `- facet ${id}: no checks — every facet needs 4-10 verifiable checks (scene/pixel/probe/demo first)`,
    ),
  ].join("\n");
}

/** The plan as the run keeps it: facets sized and named once, the base, the game it declares. */
function finishPlan({
  raw,
  facets: planned,
  validation,
  scout,
  run,
  known,
}: PlannerAnswer & { scout: AnyRecord | null; run: Run; known: KnownGame }): AnyRecord {
  let facets = planned;
  // The scout's builder count is the ceiling: a plan that split one scene into six
  // anyway is folded back — the first N by share, and at one builder a single facet that
  // keeps every check the planner wrote, so nothing is judged by taste alone.
  const ceiling = scout?.workers?.count;
  const moreThanItCanRun = Number.isFinite(ceiling) && ceiling >= 1 && facets.length > ceiling;
  if (moreThanItCanRun) {
    facets = clampFacets(facets, ceiling, run);
    if (raw) raw.mainOwner = facets.some((f) => f.id === raw.mainOwner) ? raw.mainOwner : facets[0].id;
  }
  giveUniqueIds(facets);
  normalizeShares(facets);
  const assumptions = Array.isArray(raw?.assumptions) ? raw.assumptions.map(String).slice(0, MAX_ASSUMPTIONS) : [];
  if (validation.length)
    assumptions.push(
      `dropped ${validation.length} unusable check(s) from the plan: ${validation.slice(0, DROPPED_CHECKS_NAMED).join("; ")}${validation.length > DROPPED_CHECKS_NAMED ? "; …" : ""}`,
    );
  const declared = declaredGame(raw);
  return {
    facets,
    genres: planGenres(raw),
    game: declared ?? known.game,
    gameFrom: declared ? GameSource.Plan : known.from,
    mainOwner: mainOwnerOf(raw, facets),
    base: planBase(raw),
    integrationNotes: typeof raw?.integrationNotes === "string" ? raw.integrationNotes : "",
    assumptions,
    validation,
  };
}

/** Ids must be unique — a duplicate facet id would share a worktree and a thread. */
function giveUniqueIds(facets: AnyRecord[]): void {
  const seen = new Set();
  for (const f of facets) {
    let id = f.id;
    for (let n = 2; seen.has(id); n++) id = `${f.id}-${n}`;
    f.id = id;
    seen.add(id);
  }
}

/** Budget shares that sum to one (equal shares when the planner gave none). */
function normalizeShares(facets: AnyRecord[]): void {
  const total = facets.reduce((sum, f) => sum + f.budgetShare, 0);
  for (const f of facets) f.budgetShare = total > 0 ? f.budgetShare / total : 1 / facets.length;
}

/**
 * main.js/studio.js get exactly one owner, mechanically — a prose rule the decomposer may
 * forget produced a run where 2 of 3 merges conflicted on main.js. Fall back to the
 * largest-share facet so the guarantee holds even when the model omits the field.
 */
function mainOwnerOf(raw: AnyRecord | null, facets: AnyRecord[]): string {
  if (raw && facets.some((f) => f.id === raw.mainOwner)) return raw.mainOwner;
  return facets.reduce((a, b) => (b.budgetShare > a.budgetShare ? b : a)).id;
}

/** The files the base builder lays down, as the planner named them: safe paths only. */
function planBase(raw: AnyRecord | null): AnyRecord | null {
  if (!raw?.base || typeof raw.base !== "object") return null;
  const files = Array.isArray(raw.base.files) ? raw.base.files : [];
  return {
    notes: typeof raw.base.notes === "string" ? raw.base.notes.slice(0, BASE_NOTES_CHARS) : "",
    files: files
      .filter((f: AnyRecord) => f && typeof f.path === "string" && isSafePlanPath(f.path))
      .slice(0, MAX_BASE_FILES)
      .map((f: AnyRecord) => ({ path: f.path, purpose: clip(f.purpose, CLIP_DETAIL) })),
  };
}

function isSafePlanPath(file: string): boolean {
  return /^[a-z0-9_./-]+$/i.test(file) && !file.includes("..");
}

function planGenres(raw: AnyRecord | null): string[] {
  if (!Array.isArray(raw?.genres)) return [];
  return raw.genres
    .map((g) => String(g).toLowerCase().trim())
    .filter(Boolean)
    .slice(0, MAX_GENRES);
}

/**
 * The game the plan itself declares, when it declares anything. The four declaration sources,
 * in order: what the planner said, then the scout's kind, then studio.json's nested game block,
 * then nothing. Only the first is written back.
 */
function declaredGame(raw: AnyRecord | null): AnyRecord | null {
  const game = raw?.game;
  if (!isPlainRecord(game)) return null;
  const declared = normalizeGameTraits(game);
  const declaresAnything =
    declared.kind || declared.hud || declared.mouseLook || declared.keyboardMove || declared.playScript;
  return declaresAnything ? declared : null;
}

/**
 * Fold a plan back to `ceiling` facets. Above one: the largest shares stay. At one: a single
 * facet for the whole goal that carries every check, camera and owned file the planner wrote.
 */
export function clampFacets(facets: AnyRecord[], ceiling: number, run: Pick<Run, "goal">): AnyRecord[] {
  const limit = Math.max(1, Math.round(ceiling));
  if (facets.length <= limit) return facets;
  if (limit > 1) {
    return [...facets]
      .map((f: AnyRecord, i: number) => ({ f, i }))
      .sort((a, b) => b.f.budgetShare - a.f.budgetShare || a.i - b.i)
      .slice(0, limit)
      .sort((a, b) => a.i - b.i)
      .map(({ f }) => f);
  }
  const first = facets[0];
  const seenChecks = new Set<string>();
  const checks: AnyRecord[] = [];
  for (const facet of facets) {
    for (const check of facet.checks ?? []) {
      if (seenChecks.has(check.id) || checks.length >= MAX_WHOLE_GAME_CHECKS) continue;
      seenChecks.add(check.id);
      checks.push(check);
    }
  }
  const union = (key: string): string[] => [...new Set<string>(facets.flatMap((f) => f[key] ?? []))];
  return [
    normalizeFacetSpec(
      {
        id: WHOLE_GAME_FACET,
        title: first.title,
        intent: run.goal,
        owns: union("owns"),
        identity: union("identity").slice(0, WHOLE_GAME_IDENTITY),
        cameras: union("cameras").slice(0, WHOLE_GAME_CAMERAS),
        checks,
        milestones: facets.flatMap((f) => f.milestones ?? []).slice(0, WHOLE_GAME_MILESTONES),
        budgetShare: 1,
      },
      0,
    ),
  ];
}

/** The base builder's brief and the contract-wiring sentence: prompts-build.ts, exported here as they always were. */
export { baseBrief, contractWiringAsk };

/** Every facet's identity checks (not its play checks), each once, and every camera they use. */
function identityChecksOf(
  plan: AnyRecord,
  facetResults: Record<string, AnyRecord | undefined>,
): { checks: AnyRecord[]; cameras: Set<string> } {
  const checks: AnyRecord[] = [];
  const cameras = new Set(["default"]);
  for (const facet of plan.facets) {
    const spec = facetResults[facet.id]?.spec ?? facet;
    for (const camera of spec.cameras ?? []) cameras.add(camera);
    for (const check of spec.checks ?? []) {
      if (check.weight !== CheckWeight.Identity || check.kind === CheckKind.Play) continue;
      if (checks.some((c) => c.id === check.id)) continue;
      checks.push({ ...check, hard: false, note: `identity check of facet ${facet.id}` });
    }
  }
  return { checks, cameras };
}

/** The integration facet's spec: every facet's identity checks on the merged build, and one play check. */
function integrationSpec(
  plan: AnyRecord,
  facetResults: Record<string, AnyRecord | undefined>,
  { screen = true }: { screen?: boolean } = {},
) {
  const { checks, cameras } = identityChecksOf(plan, facetResults);
  checks.push({
    id: "integration-play",
    kind: CheckKind.Play,
    weight: CheckWeight.Normal,
    hard: false,
    ask: "Could you move through the world, reach what the goal describes, and use its core verb without getting stuck, falling through, or losing sight of what to do?",
    expect: "yes",
  });
  return withHarnessChecks(
    {
      id: INTEGRATION_FACET,
      title: "Integration",
      intent:
        `The merged game: every facet's identity features present together, seams reconciled (palette, scale, lighting, spawn), nothing a facet registered lost. ${plan.integrationNotes ?? ""}`.trim(),
      brief: plan.integrationNotes ?? "",
      owns: [],
      identity: plan.facets.flatMap((f: AnyRecord) => f.identity ?? []).slice(0, INTEGRATION_IDENTITY),
      cameras: [...cameras].slice(0, INTEGRATION_CAMERAS),
      checks: checks as Check[],
      budgetShare: 0,
    },
    { role: INTEGRATION_FACET, game: plan.game, screen },
  );
}

export async function runAutopilot(
  ctx: HarnessCtx,
  { threadId, run, resume = false }: { threadId: string; run: Run; resume?: boolean },
): Promise<any> {
  // The run's own state, phase to phase: its arguments, then what each phase sets up for the
  // phases after it (`pipeline.journal`, `pipeline.integrationHead`, …).
  const pipeline: Pipeline = { ctx, threadId, run, resume };
  for (const phase of PIPELINE_PHASES) {
    const done = await phase(pipeline);
    if (done) return done.value;
  }
}

/**
 * What a classic run does, in order. Each phase reads and writes the run's state (`pipeline`)
 * and answers `{ value }` to end the run with that result, or nothing to hand on to the next
 * phase.
 */
const PIPELINE_PHASES = [
  openPipeline,
  planFacets,
  gatherReferences,
  openReport,
  buildBase,
  reviewPlan,
  openIntegration,
  runFacets,
  integrateFacets,
  judgeIntegration,
  landIntegrated,
  judgeGlobally,
  closePipeline,
];

/** The budget, the preview pool, the workers' engine, a resumed journal and the project's own shape. */
async function openPipeline(pipeline: Pipeline): Promise<PipelineEnd> {
  const { ctx, resume, run, threadId } = pipeline;
  pipeline.inbox = ctx.runInbox ?? createRunInbox(ctx, { threadId, runId: run.runId });
  const started = Date.now();
  pipeline.started = started;
  const total = run.budgets?.wallClockMs ?? DEFAULT_WALL_CLOCK_MS;
  pipeline.total = total;
  pipeline.finalDeadline = started + total;
  pipeline.deadline = pipeline.finalDeadline - optimizationAllowance(total);
  pipeline.seed = PAGE_SEED;

  ctx.setStatus(`run ${run.runId} · planning facets`);
  // The modeller (AG-930): the studio says whether Blender is on and found; the run records
  // it once so the planner, every builder and the Builds graph read the same answer.

  const described = await ctx.call(HostMethod.EngineDescribe, {});
  pipeline.described = described;
  const capacity = await ctx.call(HostMethod.PreviewCapacity, {}).catch(() => null);
  pipeline.capacity = capacity;
  const previewPoolMax = typeof capacity?.max === "number" && capacity.max > 0 ? capacity.max : null;
  pipeline.previewPoolMax = previewPoolMax;
  // How many build at once is the workers' engine's question (cross-provider roles).
  pipeline.profile = concurrencyProfile(described, roleEngine(run, RoleKey.Builder), { previewPoolMax });

  // Resume replays the journal (Claude-Code-Workflow semantics, A4): the plan is never
  // re-decomposed, completed facets return their recorded results instantly, only unfinished
  // work runs live.
  pipeline.priorJournal = resume ? await readJournal(ctx, threadId, run.runId) : null;
  // The project's own shape: a game the user brought (Vite, TypeScript, its own build and its
  // own UI) keeps its entry and its screen; the studio builds it before every preview.
  const games = await ctx.call(HostMethod.GameList, {}).catch(() => []);
  const projectDescriptor = games.find((g: AnyRecord) => g.name === run.project) ?? null;
  pipeline.projectDescriptor = projectDescriptor;
  pipeline.ownShape = projectDescriptor?.built === true;
  pipeline.shape = projectDescriptor?.shape ?? { entry: "index.html", main: "src/main.js", build: null };
}

/** The look before the plan, the plan and its boards; a saved finalization resumes here, and a one-facet plan is the single path. */
async function planFacets(pipeline: Pipeline): Promise<PipelineEnd> {
  const { ctx, described, ownShape, previewPoolMax, priorJournal, run } = pipeline;
  pipeline.storedGame = null;
  const plan = priorJournal?.plan ?? (await newPlan(pipeline));
  pipeline.plan = plan;
  stampRunFromPlan(run, plan, ownShape);
  // A kind the plan itself declared is written back into the user's studio.json once, so the
  // next run on this game starts knowing it. A scout's guess is never written.
  const planDeclaredGame = !priorJournal?.plan && plan.gameFrom === GameSource.Plan && plan.game;
  if (planDeclaredGame) {
    await writeDeclaredGame(ctx, run.project, plan.game, { from: GameSource.Plan }).catch(() => {});
  }
  addHarnessBoards(pipeline, plan);
  // Parallelism sized to the plan and the preview pool, not a constant (WP6).
  pipeline.profile = concurrencyProfile(described, roleEngine(run, RoleKey.Builder), {
    facets: plan.facets.length,
    previewPoolMax,
  });
  // Resume directly at a saved finalization boundary: no decomposer, builder or integrator replay.
  if (priorJournal?.finalization) return resumeFinalization(pipeline);
  if (plan.facets.length <= 1) return runSingleFacet(pipeline);
}

/**
 * A fresh plan: the look before it — a read-only session opens the
 * game with the computer tool, plays to the state the brief is about, and says how many builders
 * the ask deserves — then the planner. A direct engine or a failed scout leaves the planner to
 * the brief alone, and the decision card says so.
 */
async function newPlan(pipeline: Pipeline): Promise<AnyRecord> {
  const { ctx, ownShape, run } = pipeline;
  const scouted = ctx.cancelled ? null : await scoutTheGame(pipeline);
  const scout = scouted?.report ?? null;
  // studio.json's nested `game` block — the third declaration source, and the file the plan's
  // own declaration is written back into once a run.
  const storedGame = await readDeclaredGame(ctx, run.project).catch(() => null);
  pipeline.storedGame = storedGame;
  const plan = await decompose(ctx, { run, profile: pipeline.profile, scout, storedGame, ownShape });
  plan.scout = scout;
  plan.setup = scout?.setup ?? null;
  const cards = scoutCards(plan, scout, scouted?.skipped ?? null, pipeline.profile.delegated);
  plan.assumptions.unshift(...cards);
  return plan;
}

/** The scout's look at the game, with its transcript kept as a run artifact. */
async function scoutTheGame(pipeline: Pipeline): Promise<AnyRecord> {
  const { ctx, ownShape, projectDescriptor, run, shape, threadId } = pipeline;
  const scouted = await runScout(ctx, {
    threadId,
    run,
    profile: pipeline.profile,
    projectDir: projectDescriptor?.dir ?? null,
    shape,
    ownShape,
  });
  if (scouted.transcript) await saveRunArtifact(ctx, run, "scout.md", scouted.transcript);
  return scouted;
}

/** Keep `text` as a run artifact (report.json, scout.md…); a write that fails is not the run's failure. */
async function saveRunArtifact(ctx: HarnessCtx, run: Pick<Run, "runId">, name: string, text: string): Promise<void> {
  await ctx
    .call(HostMethod.RunArtifact, { runId: run.runId, name, base64: Buffer.from(text).toString("base64") })
    .catch(() => {});
}

/** The decision cards the scout leaves on a fresh plan, in the order they head its assumptions. */
function scoutCards(plan: AnyRecord, scout: AnyRecord | null, skipped: string | null, delegated: boolean): string[] {
  if (!scout) {
    // A direct engine never scouts (no hands); only a delegated engine's missing look is news.
    if (!delegated) return [];
    return [
      `no scout (${skipped ?? "unavailable"}) — the plan was made from the brief alone, and the run looks at whatever the game boots into`,
    ];
  }
  const verified = scout.setup?.verify ? `, verified by ${scout.setup.verify.path}` : "";
  const reached = scout.reachedRequested ? "" : " (the scout did not confirm it got there)";
  const seen = `scouted first: on load the game shows ${scout.seen || "(unsaid)"}; the brief is about ${scout.requested || "(unsaid)"} — reached by ${setupReach(scout.setup)}${verified}${reached}`;
  if (!scout.workers) return [seen];
  const count = scout.workers.count;
  const mismatch = plan.facets.length !== count ? ` — the plan has ${plan.facets.length} facet(s)` : "";
  const builders = `${count} builder${count === 1 ? "" : "s"}: ${scout.workers.why || "the scout's call"}${mismatch}`;
  return [builders, seen];
}

/** How the scout reaches the state the brief is about. */
function setupReach(setup: AnyRecord | null | undefined): string {
  if (!setup) return "no setup — the boot screen is the requested state";
  if (setup.demo) return `demo "${setup.demo}"`;
  return `${(setup.actions ?? []).length} input action(s)`;
}

/**
 * The plan's facts on the run record, BEFORE the base builder forks: the requested state rides
 * on the run (every evidence pass, capture and worker window replays it; a resumed run reads it
 * back from its journaled plan), and so does what kind of game this is — every judge, every
 * brief and the artefact-class filter read it from here, and nothing threads it through a judge
 * signature. `ownShape` and `genres` ride with it for the same reason.
 */
function stampRunFromPlan(run: Run, plan: AnyRecord, ownShape: boolean): void {
  run.setup = plan.setup ?? null;
  run.game = plan.game ?? null;
  run.ownShape = ownShape;
  run.genres = plan.genres ?? [];
}

/**
 * The harness's own checks on every typed facet. Older journals carry prose facets; the loop
 * wants specs. One screen (no DOM UI, one HUD) on all of them, one input path (look turns the
 * camera, keys move the player) on the facet that owns main.js; a prose-only plan is left to the
 * taste judge, as before. And the requested state on every board, when the scout wrote a probe.
 */
function addHarnessBoards(pipeline: Pipeline, plan: AnyRecord): void {
  const { ownShape } = pipeline;
  plan.facets = plan.facets.map((f: AnyRecord, i: number) => (Array.isArray(f.checks) ? f : normalizeFacetSpec(f, i)));
  plan.facets = plan.facets.map((f: AnyRecord) =>
    f.checks.length > 0
      ? withHarnessChecks(f, {
          ownsMain: !plan.mainOwner || plan.mainOwner === f.id,
          game: plan.game,
          screen: !ownShape,
        })
      : f,
  );
  const requestedExpr = setupVerifyExpr(plan.setup?.verify);
  pipeline.requestedExpr = requestedExpr;
  if (!requestedExpr) return;
  plan.facets = plan.facets.map((f: AnyRecord) =>
    f.checks.length > 0 ? withRequestedStateCheck(f, { expr: requestedExpr, note: plan.setup?.note ?? "" }) : f,
  );
}

/** A run resumed at its saved finalization: only the optimization pass and the close are left. */
async function resumeFinalization(pipeline: Pipeline): Promise<PipelineEnd> {
  const { ctx, finalDeadline, priorJournal, run, threadId } = pipeline;
  await appendRunEventStrict(ctx, threadId, RunEvent.RunStarted, {
    runId: run.runId,
    project: run.project,
    goal: run.goal,
    mode: RunMode.Autopilot,
    resumed: true,
  });
  const report = priorJournal.finalization.report;
  await finalizeOptimization(ctx, { threadId, run, journal: priorJournal, report, deadline: finalDeadline });
  return { value: closeRun(ctx, { threadId, run, report, journal: priorJournal, catalogue: null }) };
}

/** One custom event on the run's thread; a failed write fails the phase (run-events.ts `appendRun` logs it instead). */
async function appendRunEventStrict(
  ctx: HarnessCtx,
  threadId: string,
  eventType: string,
  payload: AnyRecord,
): Promise<void> {
  await ctx.call(HostMethod.EventsAppend, {
    threadId,
    batch: [{ type: EventKind.Custom, event_type: eventType, payload }],
  });
}

/** A one-facet plan is the single path: the gauntlet, journaled so a resume picks it up. */
async function runSingleFacet(pipeline: Pipeline): Promise<PipelineEnd> {
  const { ctx, deadline, finalDeadline, plan, priorJournal, run, threadId } = pipeline;
  const journal = priorJournal ?? {
    runId: run.runId,
    run: { ...run, reference: { ...run.reference, frames: undefined, stats: undefined } },
    plan,
    phase: JournalPhase.Single,
    facets: {},
    base: null,
  };
  const save = () => writeJournal(ctx, threadId, run.runId, journal);
  await save();
  const progress = journal.singleProgress
    ? {
        ...journal.singleProgress,
        incumbentEvidence: await restoreFrames(journal.singleProgress.incumbentEvidence),
        startingEvidence: await restoreFrames(journal.singleProgress.startingEvidence),
      }
    : null;
  return {
    value: runGauntlet(ctx, {
      threadId,
      run,
      origin: FinalizationOrigin.Single,
      creativeDeadline: deadline,
      resumeState: progress,
      onProgress: async (progress) => {
        journal.singleProgress = withoutFrames(progress);
        await save();
      },
      beforeFinalPublication: async ({ report, incumbent, incumbentEvidence, startingSnapshot, startingEvidence }) => {
        // A user Stop pauses the building where it was: journaling the finalization here
        // made Resume skip the rest of the run and optimize the build as it stood.
        if (report.stopCode === StopCode.UserStop) return pauseSingle(ctx, { threadId, run, journal });
        journal.finalization = withoutFrames({
          report,
          origin: FinalizationOrigin.Single,
          baselineSnapshot: incumbent,
          baselineVerified: incumbent?.healthy === true,
          baselineEvidence: incumbentEvidence,
          startingSnapshot,
          startingEvidence,
          specs: plan.facets,
          requiredChecks: [],
        });
        await save();
        await finalizeOptimization(ctx, { threadId, run, journal, report, deadline: finalDeadline });
        journal.phase =
          report.optimization?.outcome === OptimizationOutcome.Interrupted ? JournalPhase.Paused : JournalPhase.Done;
        await save();
        if (journal.phase === JournalPhase.Paused)
          await appendRunEventStrict(ctx, threadId, RunEvent.AutopilotPaused, {
            runId: run.runId,
            project: run.project,
          });
      },
    }),
  };
}

/** A one-facet run the user stopped: its journal paused on the progress it saved, and the paused card. */
async function pauseSingle(
  ctx: HarnessCtx,
  { threadId, run, journal }: { threadId: string; run: Run; journal: AnyRecord },
): Promise<void> {
  journal.phase = JournalPhase.Paused;
  await writeJournal(ctx, threadId, run.runId, journal);
  await appendRunEventStrict(ctx, threadId, RunEvent.AutopilotPaused, { runId: run.runId, project: run.project });
}

/** Reference stills that actually arrive, and their statistics. */
async function gatherReferences(pipeline: Pipeline): Promise<PipelineEnd> {
  const { ctx, plan, run } = pipeline;
  // ── reference stills that actually arrive (WP3c) and their statistics (WP4c) ──
  const referenceNotes: string[] = [];
  pipeline.referenceNotes = referenceNotes;
  if (!run.reference) run.reference = { name: "unnamed", shots: [] };
  if (!(run.reference.frames?.length > 0)) referenceNotes.push(...(await loadReferencesFromDisk(ctx, run)));
  if (!run.reference.frames?.length) return;
  const stats = await measureReferences(ctx, run.reference.frames);
  run.reference.stats = stats;
  await saveRunArtifact(ctx, run, "reference-stats.json", JSON.stringify(stats, null, 2));
  // Every facet carries one identity metric — the distance to the nearest still on its
  // primary camera — so "looks like the stills" is on the board, not only in the prose (WP4d).
  if (stats.length)
    plan.facets = plan.facets.map((f: AnyRecord) =>
      f.checks.length > 0 ? withStyleMetric(f, { hasReference: true }) : f,
    );
  referenceNotes.push(
    `${run.reference.frames.length} reference still(s) in every judge call and the first brief; style distance measured on ${stats.length} of them`,
  );
}

/**
 * A resumed run, or a board attached in an earlier chat: the stills live on disk. Loads them onto
 * the run's reference and answers the decision notes about what was loaded and skipped.
 */
async function loadReferencesFromDisk(ctx: HarnessCtx, run: Run): Promise<string[]> {
  const notes: string[] = [];
  const fromDisk = await ctx
    .call(HostMethod.GameReferences, { project: run.project, max: MAX_REFERENCE_STILLS, maxPx: REFERENCE_MAX_PX })
    .catch(() => null);
  const frames = fromDisk?.frames ?? [];
  if (frames.length) {
    run.reference.frames = frames;
    // Two stills or more make a reference; a direction keeps its kind on one.
    const enoughStills = frames.length >= REFERENCE_MIN_STILLS;
    if (run.reference.kind !== ReferenceKind.Direction || enoughStills)
      run.reference.kind = enoughStills ? ReferenceKind.Reference : run.reference.kind;
    notes.push(
      `loaded ${frames.length} reference still(s) from references/: ${frames.map((f: AnyRecord) => f.label).join(", ")}`,
    );
  }
  for (const skip of fromDisk?.skipped ?? []) notes.push(`reference skipped: ${skip.file} is ${skip.why}`);
  return notes;
}

/** Each still's colour statistics, for the style metric. */
async function measureReferences(ctx: HarnessCtx, frames: AnyRecord[]): Promise<AnyRecord[]> {
  const stats: AnyRecord[] = [];
  for (const [index, frame] of frames.entries()) {
    try {
      const measured = await ctx.call(HostMethod.PreviewStatsOf, { base64: frame.data });
      if (measured?.stats)
        stats.push({
          label: frame.label || String(index + 1),
          stats: measured.stats,
          width: measured.width,
          height: measured.height,
        });
    } catch {
      /* a still without stats is still a picture for the judges; only the metric skips it */
    }
  }
  return stats;
}

/** The report, the journal, the scaffold and its contract, the loaded preview and the check catalogue. */
async function openReport(pipeline: Pipeline): Promise<PipelineEnd> {
  const { ctx, plan, priorJournal, run, threadId } = pipeline;
  const report = {
    runId: run.runId,
    project: run.project,
    goal: run.goal,
    reference: run.reference?.name ?? "unnamed",
    referenceStills: (run.reference?.frames ?? []).map((f: AnyRecord) => f.label),
    mode: RunMode.Autopilot,
    plan,
    scout: plan.scout ?? null,
    setup: plan.setup ?? null,
    facets: {},
    iterations: [],
    victory: false,
    stoppedBecause: "",
  };
  pipeline.report = report;
  await ctx.call(HostMethod.EventsAppend, { threadId, batch: runOpeningEvents(pipeline) });

  // `run` rides in the journal so a resume can reconstruct the spec — minus the reference
  // frames, which stay out of the log (they live in <project>/references/ instead).
  const journalRun = { ...run, reference: { ...(run.reference ?? {}), frames: undefined, stats: undefined } };
  pipeline.journalRun = journalRun;
  const journal = {
    runId: run.runId,
    run: journalRun,
    plan,
    phase: JournalPhase.Facets,
    facets: { ...(priorJournal?.facets ?? {}) },
    base: priorJournal?.base ?? null,
    steeringCursor: null,
    ...(priorJournal?.optimization ? { optimization: priorJournal.optimization } : {}),
  };
  pipeline.journal = journal;
  const saveJournal = () => saveRunJournal(ctx, threadId, run.runId, journal);
  pipeline.saveJournal = saveJournal;
  await saveJournal();
  await prepareFolder(pipeline);
}

/** What a run's start puts on its thread, in order: the start, the notes, the resume, the plan, the cards. */
function runOpeningEvents(pipeline: Pipeline): AnyRecord[] {
  const { plan, priorJournal, referenceNotes, resume, run } = pipeline;
  const decision = (text: string) => ({
    type: EventKind.Custom,
    event_type: RunEvent.AutopilotDecision,
    payload: { runId: run.runId, decision: text, at: new Date().toISOString() },
  });
  const doneFacets = (Object.entries(priorJournal?.facets ?? {}) as Array<[string, AnyRecord]>)
    .filter(([, r]) => r?.done)
    .map(([id]) => id);
  return [
    { type: EventKind.Custom, event_type: RunEvent.RunStarted, payload: runStartedPayload(run, resume) },
    ...referenceNotes.map(decision),
    ...(resume
      ? [{ type: EventKind.Custom, event_type: RunEvent.AutopilotResumed, payload: { runId: run.runId, doneFacets } }]
      : []),
    { type: EventKind.Custom, event_type: RunEvent.AutopilotStarted, payload: autopilotStartedPayload(pipeline) },
    // Every call made without data is a decision card the user can overturn by steering.
    // On resume the cards already stand in the log — no duplicates.
    ...(resume ? [] : plan.assumptions.map(decision)),
  ];
}

/** The `run_started` payload: who builds and judges, the reference, the budgets. */
function runStartedPayload(run: Run, resume: boolean): AnyRecord {
  return {
    runId: run.runId,
    goal: run.goal,
    project: run.project,
    mode: RunMode.Autopilot,
    ...(run.engine ? { engine: run.engine } : {}),
    ...(run.model ? { model: run.model } : {}),
    ...(run.roles ? { roles: run.roles } : {}),
    ...(run.judgeModel ? { judgeModel: run.judgeModel } : {}),
    ...(run.builderEngine ? { builderEngine: run.builderEngine } : {}),
    ...(run.judgeEngine ? { judgeEngine: run.judgeEngine } : {}),
    ...(resume ? { resumed: true } : {}),
    reference: {
      name: run.reference?.name,
      shots: run.reference?.shots ?? [],
      notes: run.reference?.notes,
      kind: run.reference?.kind,
      frameCount: run.reference?.frames?.length ?? 0,
      frames: (run.reference?.frames ?? []).map((f: AnyRecord) => f.label),
    },
    budgets: run.budgets,
    blender: run.blender ?? null,
  };
}

/** The `autopilot_started` payload: the facets, the parallelism, the scout's look and the setup. */
function autopilotStartedPayload(pipeline: Pipeline): AnyRecord {
  const { plan, resume, run } = pipeline;
  const { scout, setup } = plan;
  return {
    runId: run.runId,
    project: run.project,
    facets: plan.facets.map(({ id, title, budgetShare, checks }: AnyRecord) => ({
      id,
      title,
      budgetShare,
      checks: (checks ?? []).length,
    })),
    integrationNotes: plan.integrationNotes,
    maxParallel: pipeline.profile.maxParallel,
    ...(scout
      ? {
          scout: {
            seen: scout.seen,
            requested: scout.requested,
            workers: scout.workers,
            reachedRequested: scout.reachedRequested === true,
          },
        }
      : {}),
    ...(setup
      ? {
          setup: {
            note: setup.note ?? null,
            demo: setup.demo ?? null,
            actions: (setup.actions ?? []).length,
            verify: setup.verify ?? null,
          },
        }
      : {}),
    ...(resume ? { resumed: true } : {}),
  };
}

/** The game folder made ready: scaffolded, its contract current, loaded in the preview; the catalogue read. */
async function prepareFolder(pipeline: Pipeline): Promise<void> {
  const { ctx, run, threadId } = pipeline;
  await ctx.call(HostMethod.GameScaffold, { name: run.project, title: run.project });
  // A game scaffolded before the v2 contract gets the current studio.js (its old copy kept
  // beside it), so scene checks and eye cameras exist from the first iteration.
  const upgraded = await ctx.call(HostMethod.GameUpgradeContract, { project: run.project }).catch(() => null);
  pipeline.upgraded = upgraded;
  if (upgraded?.upgraded) {
    await appendRunEvent(ctx, threadId, RunEvent.AutopilotDecision, {
      runId: run.runId,
      decision: `upgraded src/studio.js to the v2 contract (the previous copy is kept as ${upgraded.backup}); main.js must pass scene/renderer/camera/player to installStudio`,
      at: new Date().toISOString(),
    });
  }
  // An edited older HUD stays and is said so; its generation rides on the run into every brief.
  const hud = noteHudUpgrade(run, upgraded);
  if (hud)
    await appendRunEvent(ctx, threadId, RunEvent.AutopilotDecision, {
      runId: run.runId,
      decision: hud.decision,
      at: new Date().toISOString(),
    });
  // An edited contract stays as it is, and the record says which HUD calls its facade may lack.
  const kept = keptContractWords(upgraded);
  if (kept) {
    await appendRunEvent(ctx, threadId, RunEvent.AutopilotDecision, {
      runId: run.runId,
      decision: kept.record,
      plain: kept.plain,
      at: new Date().toISOString(),
    });
  }
  await ctx.call(HostMethod.PreviewLoad, { project: run.project });
  pipeline.startingConsole = await inheritedConsoleAfterLoad(ctx);
  const games = await ctx.call(HostMethod.GameList, {}).catch(() => []);
  pipeline.games = games;
  pipeline.projectDir = games.find((g: AnyRecord) => g.name === run.project)?.dir ?? null;
  pipeline.worktreeMode = pipeline.profile.maxParallel > 1;
  pipeline.catalogue = await loadCatalogue(ctx.workspace);
}

/** The shared base commit — the seam is code, not prose — and the incumbent it starts from. */
async function buildBase(pipeline: Pipeline): Promise<PipelineEnd> {
  const { ctx, journal, saveJournal } = pipeline;
  // ── shared base commit: the seam is code, not prose ──
  journal.phase = JournalPhase.Base;
  await saveJournal();
  if (!journal.base && !ctx.cancelled) {
    const ended = await buildSharedBase(pipeline);
    if (ended) return ended;
  }
  const refused = await refuseBlindFacets(pipeline);
  if (refused) return refused;
  await openIncumbent(pipeline);
}

/** What the base builder's session came to: built, failed (and why), or stopped by the user. */
interface BaseBuild {
  ok: boolean;
  error: string | null;
  stopped?: boolean;
}

/** Build the shared base in the live folder, keep it when it loads, and roll it back when it does not. */
async function buildSharedBase(pipeline: Pipeline): Promise<PipelineEnd> {
  const { catalogue, ctx, journal, report, run, saveJournal, threadId } = pipeline;
  ctx.setStatus(`run ${run.runId} · building the shared base`);
  // The base builder edits the live folder. Keep a way back that includes the user's own
  // uncommitted and untracked work: a failed base returns here, never to a bare `reset --hard`
  // (which erased pre-run edits in adopted repositories). A resumed run reuses the snapshot
  // taken before its first attempt, so the way back is always the user's state, not a half-built base.
  if (!journal.preBaseSnapshot) {
    const before = await ctx
      .call(HostMethod.SnapshotCreate, {
        scope: "game",
        reason: `run ${run.runId}: before the shared base`,
        project: run.project,
      })
      .catch(() => null);
    journal.preBaseSnapshot = before?.snapshot_id ?? null;
    await saveJournal();
  }
  const built = await runBaseBuilder(pipeline);
  if (built.stopped) {
    stopRun(report, StopCode.UserStop, STOPPED_BY_USER);
    return { value: closeRun(ctx, { threadId, run, report, journal, catalogue }) };
  }
  // The base must load; otherwise every facet forks from the scaffold, honestly reported.
  const evidence = built.ok ? await baseEvidence(pipeline) : null;
  if (built.ok && evidence?.ok) {
    journal.base = await commitBase(pipeline, evidence);
  } else {
    const error = built.error ?? evidence?.problems?.join("; ") ?? "base build did not load";
    const ended = await rollBackBase(pipeline, error);
    if (ended) return ended;
  }
  await appendRunEventStrict(ctx, threadId, RunEvent.AutopilotBase, {
    runId: run.runId,
    ok: journal.base.ok,
    commit: journal.base.commit,
    error: journal.base.error ?? null,
    empty: journal.base.empty === true,
  });
  await saveJournal();
}

/** The base builder's session: a delegated contractor, or a direct engine's build turn. */
async function runBaseBuilder(pipeline: Pipeline): Promise<BaseBuild> {
  const { ctx, deadline, ownShape, plan, projectDir, run, shape, threadId } = pipeline;
  const brief = baseBrief({ run, plan, projectLabel: run.project, shape, ownShape, setup: run.setup ?? null });
  const effort = roleEffort(run, RoleKey.Builder);
  const turn = {
    engine: roleEngine(run, RoleKey.Builder),
    prompt: brief,
    project: run.project,
    threadId,
    runId: run.runId,
    model: run.model,
    ...(effort ? { effort } : {}),
  };
  try {
    if (!pipeline.profile.delegated) {
      await buildTurn(ctx, {
        ...turn,
        delegated: false,
        metadata: { runId: run.runId, phase: BASE_FACET },
        deadlineMs: Math.min(deadline, Date.now() + BASE_BUILD_TIMEOUT_MS),
      });
      return { ok: true, error: null };
    }
    const delegation = await buildTurn(ctx, {
      ...turn,
      delegated: true,
      timeoutMs: Math.min(BASE_BUILD_TIMEOUT_MS, deadline - Date.now()),
      delegation: projectDir ? { selfCapture: baseSelfCapture(run, projectDir) } : {},
    });
    if (delegation.ok) return { ok: true, error: null };
    return { ok: false, error: delegation.errorText || delegation.stopReason || "base build did not finish" };
  } catch (err: any) {
    if (err?.kind === EngineFailure.Aborted || ctx.cancelled) return { ok: false, error: null, stopped: true };
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/** The base builder's own eyes on the live folder. */
function baseSelfCapture(run: Run, projectDir: string): AnyRecord {
  return {
    project: run.project,
    root: projectDir,
    runId: run.runId,
    facetId: BASE_FACET,
    iteration: 0,
    ...(run.setup ? { setup: run.setup } : {}),
    label: "base builder",
  };
}

/** Does the base load? Every facet's cameras, from the scaffold's point of view. */
async function baseEvidence(pipeline: Pipeline): Promise<AnyRecord> {
  const { ctx, plan, run, seed, startingConsole } = pipeline;
  try {
    return await gatherEvidence(ctx, {
      run,
      iterationId: BASE_FACET,
      seed,
      labelPrefix: BASE_FACET,
      cameras: [...new Set<string>(plan.facets.flatMap((f: AnyRecord) => f.cameras ?? []))],
      eyes: true,
      motion: 0,
      audio: false,
      scaffold: true,
      inheritedConsole: startingConsole,
    });
  } catch (err: any) {
    return { ok: false, problems: [String(err?.message ?? err)] };
  }
}

/** Commit the base that loads; the commit every facet forks from. */
async function commitBase(pipeline: Pipeline, evidence: AnyRecord): Promise<AnyRecord> {
  const { ctx, run } = pipeline;
  const live = { project: run.project };
  const baseGit = { label: `autopilot:${run.runId}:base`, timeoutMs: GIT_TIMEOUT_MS.quick };
  const commit = await commitAll(ctx, live, `autopilot ${run.runId}: shared base`, { allowEmpty: true, ...baseGit })
    .then(() => headOf(ctx, live, baseGit))
    .catch(() => null);
  return { commit, ok: true, empty: evidence.emptyScene === true };
}

/**
 * A broken base is rolled back to the snapshot taken just before it, so facets fork from
 * something that runs and the user's own work in the folder is kept. Without that snapshot
 * there is no safe way back: stop rather than erase anything. Answers the run's end when it stops.
 */
async function rollBackBase(pipeline: Pipeline, error: string): Promise<PipelineEnd> {
  const { catalogue, ctx, journal, report, run, saveJournal, threadId } = pipeline;
  const restored = journal.preBaseSnapshot
    ? await ctx
        .call(HostMethod.SnapshotRestore, {
          snapshotId: journal.preBaseSnapshot,
          project: run.project,
          scope: "game",
          reason: `run ${run.runId}: the shared base failed`,
        })
        .then(
          () => true,
          () => false,
        )
    : false;
  journal.base = { commit: null, ok: false, error };
  if (restored) return;
  stopRun(
    report,
    StopCode.BaseFailed,
    `the shared base failed and the game folder could not be returned safely to its state before the build (${error}); nothing was rolled back`,
  );
  await appendRunEvent(ctx, threadId, RunEvent.AutopilotBase, {
    runId: run.runId,
    ok: false,
    commit: null,
    error,
    empty: false,
  });
  await saveJournal();
  return { value: closeRun(ctx, { threadId, run, report, journal, catalogue }) };
}

/**
 * A game with its own shape has no runnable scaffold to fall back to: facets forked from a
 * base that does not load would work blind, every builder without one judged frame. Stop here and say why; the user fixes the entry, or asks a chat build to
 * install the contract in it, and starts a new build.
 */
async function refuseBlindFacets(pipeline: Pipeline): Promise<PipelineEnd> {
  const { catalogue, ctx, journal, ownShape, report, run, shape, threadId } = pipeline;
  const baseFailed = journal.base && !journal.base.ok;
  if (!baseFailed || !ownShape) return;
  stopRun(report, StopCode.BaseFailed, `the shared base could not be made judgeable: ${journal.base.error}`);
  const built = shape.build ? `, built with \`${shape.build}\`` : "";
  await appendRunEventStrict(ctx, threadId, RunEvent.AutopilotDecision, {
    runId: run.runId,
    decision: `stopped before the facets: this game has its own shape (${shape.main}${built}) and its base did not load — ${journal.base.error}. Fix the entry, or ask a chat build to install the studio contract in ${shape.main}, then start a new build.`,
    at: new Date().toISOString(),
  }).catch(() => {});
  return { value: closeRun(ctx, { threadId, run, report, journal, catalogue }) };
}

/** The incumbent every facet is judged against, and what it looks like. */
async function openIncumbent(pipeline: Pipeline): Promise<void> {
  const { ctx, journal, run, seed } = pipeline;
  pipeline.incumbent = await ctx.call(HostMethod.SnapshotCreate, {
    scope: "both",
    reason: `run ${run.runId}: autopilot starting point${journal.base?.ok ? " (shared base)" : ""}`,
    project: run.project,
  });
  pipeline.startEvidence = null;
  try {
    const evidence = await gatherEvidence(ctx, { run, iterationId: "000", seed, eyes: true, motion: 0, audio: false });
    pipeline.startEvidence = evidence.ok ? evidence : null;
  } catch {
    pipeline.startEvidence = null;
  }
}

/** Steering for the workers, and the optional plan review. */
async function reviewPlan(pipeline: Pipeline): Promise<PipelineEnd> {
  const { ctx, deadline, inbox, journal, plan, resume, run, saveJournal, threadId } = pipeline;
  // Only addressed coordinator instructions reach workers; status questions stay in chat.
  const drainSteering = () => inbox.steering(undefined, false);
  pipeline.drainSteering = drainSteering;
  pipeline.steering = (facetId: string | undefined) => inbox.steering(facetId);
  pipeline.steeringBacklog = () => inbox.backlog();

  // ── optional plan review (WP7): wait for "go" / "drop <check>" / "repoint <check> to <camera>" ──
  const reviewWanted = run.reviewPlan && !resume && !ctx.cancelled;
  if (!reviewWanted) return;
  const waitMs = Math.min(PLAN_REVIEW_WAIT_MS, Math.max(0, deadline - Date.now() - MINUTE_MS));
  // `game` rides on the card for the same reason the facets do: the kind decides the critic,
  // the harness's own checks and the controls driven before every judgement, and it is
  // written back into the user's studio.json — the review window used to show everything
  // about the run except that.
  await appendRunEvent(ctx, threadId, RunEvent.AutopilotPlanReview, planReviewCard(run, plan, waitMs));
  ctx.setStatus(`run ${run.runId} · plan ready — waiting for steering`);
  const go = await waitForPlanSteering(pipeline, Date.now() + waitMs);
  await appendRunEvent(ctx, threadId, RunEvent.AutopilotDecision, {
    runId: run.runId,
    decision: go
      ? "plan review: building on the user's go"
      : `plan review: no steering within ${Math.round(waitMs / MINUTE_MS)} min — building the plan as it stands`,
    at: new Date().toISOString(),
  });
  journal.plan = plan;
  await saveJournal();
}

/** The plan as the review card shows it: the game, and each facet's cameras and checks. */
function planReviewCard(run: Run, plan: AnyRecord, waitMs: number): AnyRecord {
  return {
    runId: run.runId,
    waitMinutes: Math.round(waitMs / MINUTE_MS),
    ...(plan.game ? { game: plan.game } : {}),
    facets: plan.facets.map((f: AnyRecord) => ({
      id: f.id,
      title: f.title,
      identity: f.identity ?? [],
      cameras: f.cameras ?? [],
      checks: (f.checks ?? []).map((c: AnyRecord) => ({
        id: c.id,
        kind: c.kind,
        weight: c.weight,
        camera: c.camera ?? null,
      })),
    })),
  };
}

/** Apply the user's plan steering until they say go, the run stops or finishes, or `until` passes. */
async function waitForPlanSteering(pipeline: Pipeline, until: number): Promise<boolean> {
  const { ctx, inbox, plan } = pipeline;
  while (Date.now() < until && !ctx.cancelled && !(await inbox.finishing())) {
    const parsed = parsePlanSteering((await pipeline.drainSteering()).join("\n"));
    applyPlanSteering(plan, parsed);
    if (parsed.go) return true;
    await sleep(PLAN_STEERING_POLL_MS);
  }
  return false;
}

/** Drop the checks the user dropped (never the harness's own) and repoint the ones they moved. */
function applyPlanSteering(plan: AnyRecord, parsed: ReturnType<typeof parsePlanSteering>): void {
  for (const drop of parsed.drops)
    for (const f of plan.facets)
      f.checks = f.checks.filter((c: AnyRecord) => c.id !== drop || c.origin === CheckOrigin.Harness);
  for (const rp of parsed.repoints)
    for (const f of plan.facets) for (const c of f.checks) if (c.id === rp.checkId && c.camera) c.camera = rp.camera;
}

/** Continuous integration: a run-level worktree every accepted facet merges into. */
async function openIntegration(pipeline: Pipeline): Promise<PipelineEnd> {
  const { ctx, incumbent, journal, report, run, worktreeMode } = pipeline;
  // ── continuous integration: a run-level worktree every accepted facet commit merges into ──
  const baseCommit = journal.base?.commit ?? incumbent?.git?.game ?? null;
  pipeline.baseCommit = baseCommit;
  pipeline.integrationWorktree = null;
  pipeline.integrationHead = baseCommit;
  pipeline.pendingMerges = [];
  pipeline.mergeLock = makeLock();
  if (worktreeMode && baseCommit) {
    try {
      const wt = await ctx.call(HostMethod.SnapshotWorktree, {
        project: run.project,
        commit: baseCommit,
        name: INTEGRATION_FACET,
        runId: run.runId,
      });
      pipeline.integrationWorktree = wt.path;
    } catch (err: any) {
      report.integrationError = `integration worktree unavailable: ${err?.message ?? err}`;
    }
  }
  pipeline.integration = pipeline.integrationWorktree
    ? {
        head: async () => pipeline.integrationHead,
        accepted: (commit: string, at: { facetId: string; iteration: number }) =>
          integrateAccepted(pipeline, commit, at),
      }
    : null;
}

/** Merge a facet's accepted commit into the integration worktree, one merge at a time. */
async function integrateAccepted(
  pipeline: Pipeline,
  commit: string,
  { facetId, iteration }: { facetId: string; iteration: number },
): Promise<void> {
  const { ctx, ownShape, pendingMerges, run, shape, threadId } = pipeline;
  const release = await pipeline.mergeLock();
  try {
    const merge = await mergeNoFf(ctx, pipeline.integrationWorktree, commit, {
      message: `autopilot ${run.runId}: integrate ${facetId} iteration ${iteration}`,
      noEdit: true,
      label: `autopilot:${run.runId}:ci:${facetId}`,
      rpcErrors: "fail",
      failure: shortFailure,
      resolve: () =>
        unionMergeMain(
          (command) =>
            ctx.call(HostMethod.RunExec, {
              command,
              cwd: pipeline.integrationWorktree,
              timeoutMs: GIT_TIMEOUT_MS.quick,
              label: `autopilot:${run.runId}:ci:union:${facetId}`,
            }),
          {
            message: `autopilot ${run.runId}: integrate ${facetId} iteration ${iteration} (union on FACET WIRING)`,
            main: shape.main,
            wiring: !ownShape,
          },
        ),
    });
    if (merge.ok) {
      pipeline.integrationHead = await headOf(ctx, pipeline.integrationWorktree, {
        label: `autopilot:${run.runId}:ci:head`,
      });
      await appendRunEvent(ctx, threadId, RunEvent.IntegrationMerge, {
        runId: run.runId,
        facetId,
        iteration,
        commit,
        head: pipeline.integrationHead,
        conflict: false,
        ...(merge.union ? { union: true } : {}),
        stage: "continuous",
      });
      return;
    }
    const pending = pendingMerges.find((p: AnyRecord) => p.facetId === facetId);
    if (pending) pending.commit = commit;
    else pendingMerges.push({ facetId, commit });
    await appendRunEvent(ctx, threadId, RunEvent.IntegrationMerge, {
      runId: run.runId,
      facetId,
      iteration,
      commit,
      conflict: true,
      stage: "continuous",
      error: String(merge.error).slice(0, CLIP_REASON),
    });
  } finally {
    release();
  }
}

/** The facet loops: two rounds of fair share, with defect routing between facets. */
async function runFacets(pipeline: Pipeline): Promise<PipelineEnd> {
  const { catalogue, ctx, deadline, journal, plan, report, run, saveJournal, threadId, total } = pipeline;
  // ── facet loops: two rounds of fair share (WP6) ──
  journal.phase = JournalPhase.Facets;
  await saveJournal();
  pipeline.previewLock = makeLock();
  pipeline.facetsDeadline = deadline - Math.round(total * FACETS_CLOSE_SHARE);
  pipeline.maxIterationsFor = (facet: AnyRecord) =>
    Math.max(
      MIN_FACET_ITERATIONS,
      Math.round((run.budgets?.maxIterations ?? DEFAULT_MAX_ITERATIONS) * shareOf(plan, facet)),
    );
  // Defect routing (WP2d): a defect the judge names while looking at one facet lands on the
  // facet that owns it — onto its live spec (read at the next brief) or, when that facet is
  // finished, onto the integration facet's ledger.
  pipeline.integrationDefects = [];
  pipeline.routeDefect = (facetId: string, check: AnyRecord) => routeDefect(pipeline, facetId, check);
  pipeline.resumeStates = new Map();
  // Round-one progress per facet: a facet at its cap yields only while some other facet has
  // not yet had its cap — "started" is not "served"; a facet that just got a slot has run nothing.
  pipeline.progress = new Map();
  pipeline.softCaps = new Map();
  pipeline.runFacet = (facet: AnyRecord, options: FacetRunOptions) => runOneFacet(pipeline, facet, options);
  const firstRound = await runFirstRound(pipeline);
  const facetResults = await runSecondRound(pipeline, firstRound);
  closeYieldedFacets(pipeline);
  await saveJournal();

  report.facets = Object.fromEntries(facetResults.filter(Boolean).map((r) => [r.facetId ?? "unknown", r]));

  if (ctx.cancelled) {
    stopRun(report, StopCode.UserStop, STOPPED_BY_USER);
    return { value: closeRun(ctx, { threadId, run, report, journal, catalogue }) };
  }
}

/** A facet's budget share, or an equal share when the plan gave it none. */
function shareOf(plan: AnyRecord, facet: AnyRecord): number {
  return facet.budgetShare > 0 ? facet.budgetShare : 1 / plan.facets.length;
}

/** Route a defect to the facet that owns it; false when no facet does. */
function routeDefect(pipeline: Pipeline, facetId: string, check: AnyRecord): boolean {
  const { integrationDefects, journal, plan } = pipeline;
  const target = plan.facets.find((f: AnyRecord) => f.id === facetId);
  if (!target) return false;
  if (journal.facets[facetId]?.done) {
    if (check?.defect) integrationDefects.push(check.defect);
    return true;
  }
  if ((target.checks ?? []).some((c: AnyRecord) => c.id === check.id)) return true;
  target.checks.push(check);
  const newCamera = check.camera && !target.cameras.includes(check.camera) && !String(check.camera).startsWith("eye:");
  if (newCamera) target.cameras.push(check.camera);
  return true;
}

/** How one facet is run in a round: its share of the rounds and the clock. */
interface FacetRunOptions {
  softCap?: number | null;
  deadline: number;
  maxIterations: number;
}

/** Round one: every facet gets its soft cap before anyone gets more. */
function runFirstRound(pipeline: Pipeline): Promise<AnyRecord[]> {
  const { facetsDeadline, plan, total, worktreeMode } = pipeline;
  return schedule(plan.facets, pipeline.profile.maxParallel, async (facet: AnyRecord) => {
    const maxIterations = pipeline.maxIterationsFor(facet);
    const softCap = Math.max(MIN_FACET_ITERATIONS, Math.round(FAIR_SHARE_FRACTION * maxIterations));
    const ownClock = Math.max(MIN_FIRST_ROUND_MS, shareOf(plan, facet) * total * FIRST_ROUND_CLOCK_SHARE);
    const facetDeadline = worktreeMode ? facetsDeadline : Math.min(facetsDeadline, Date.now() + ownClock);
    return runOneFacet(pipeline, facet, { softCap, deadline: facetDeadline, maxIterations });
  });
}

/** Round two: the yielded facets split what is left by budgetShare, sessions continued. */
async function runSecondRound(pipeline: Pipeline, firstRound: AnyRecord[]): Promise<AnyRecord[]> {
  const { ctx, facetsDeadline, inbox, plan, run, threadId, worktreeMode } = pipeline;
  const unfinished = plan.facets.filter((f: AnyRecord) => pipeline.resumeStates.has(f.id));
  pipeline.unfinished = unfinished;
  if (!unfinished.length || ctx.cancelled || (await inbox.finishing())) return firstRound;
  if (facetsDeadline - Date.now() <= MINUTE_MS) return firstRound;
  await appendRunEvent(ctx, threadId, RunEvent.AutopilotDecision, {
    runId: run.runId,
    decision: `fair share round two: ${unfinished.map((f: AnyRecord) => f.id).join(", ")} continue with the remaining ${Math.round((facetsDeadline - Date.now()) / MINUTE_MS)} min split by budget share`,
    at: new Date().toISOString(),
  });
  const totalShare = unfinished.reduce((sum: number, f: AnyRecord) => sum + shareOf(plan, f), 0) || 1;
  const remaining = facetsDeadline - Date.now();
  const second = await schedule(unfinished, pipeline.profile.maxParallel, async (facet: AnyRecord) => {
    const share = shareOf(plan, facet) / totalShare;
    const facetDeadline = worktreeMode
      ? facetsDeadline
      : Math.min(facetsDeadline, Date.now() + Math.max(MIN_SECOND_ROUND_MS, share * remaining));
    return runOneFacet(pipeline, facet, {
      softCap: null,
      deadline: facetDeadline,
      maxIterations: pipeline.maxIterationsFor(facet),
    });
  });
  const byId = new Map(second.filter(Boolean).map((r) => [r.facetId, r]));
  return firstRound.map((r) => (r && byId.has(r.facetId) ? (byId.get(r.facetId) ?? r) : r));
}

/** A facet that yielded and never got round two is done as far as this run goes. */
function closeYieldedFacets(pipeline: Pipeline): void {
  const { catalogue, journal, plan, run } = pipeline;
  for (const facet of plan.facets) {
    const record = journal.facets[facet.id];
    const steppedAside = record && !record.done && record.yielded;
    if (!steppedAside) continue;
    journal.facets[facet.id] = {
      ...record,
      done: true,
      stoppedBecause: `${record.stoppedBecause}; no time for a second round`,
    };
    if (record.spec && record.board)
      recordCatalogueOutcomes(catalogue, record.spec, record.board, CheckOrigin.Planner, {
        runId: run.runId,
        genres: plan.genres ?? [],
        kind: run.game?.kind ?? null,
      });
  }
}

/** A pooled preview port for a worktree build; null when there is none (the live view is shared). */
async function acquirePreview(pipeline: Pipeline, label: string): Promise<string | null> {
  if (!pipeline.worktreeMode) return null;
  try {
    return (await pipeline.ctx.call(HostMethod.PreviewAcquire, { label })).handle;
  } catch {
    return null;
  }
}

async function releasePreview(ctx: HarnessCtx, handle: string | null): Promise<void> {
  if (handle) await ctx.call(HostMethod.PreviewRelease, { handle }).catch(() => {});
}

/** Why a facet does not run now: done already, stopped, or finishing. Null when it runs. */
async function facetNotRun(pipeline: Pipeline, facet: AnyRecord): Promise<AnyRecord | null> {
  const { ctx, inbox, journal } = pipeline;
  const prior = journal.facets[facet.id];
  if (prior?.done) return prior;
  if (ctx.cancelled) return { facetId: facet.id, done: false, stoppedBecause: STOPPED_BY_USER };
  if (await inbox.finishing())
    return (
      prior ?? { facetId: facet.id, done: false, stoppedBecause: "finishing the current work at the user’s request" }
    );
  return null;
}

/** Run one facet's loop in its own thread (and worktree), and journal what it did. */
async function runOneFacet(pipeline: Pipeline, facet: AnyRecord, options: FacetRunOptions): Promise<AnyRecord> {
  const { ctx, journal, run } = pipeline;
  const skipped = await facetNotRun(pipeline, facet);
  if (skipped) return skipped;
  const prior = journal.facets[facet.id];
  if (options.softCap) pipeline.softCaps.set(facet.id, options.softCap);
  const facetThread =
    prior?.threadId ?? (await ctx.call(HostMethod.ThreadCreate, { title: `${run.runId} · ${facet.title}` }));
  const state = pipeline.resumeStates.get(facet.id) ?? null;
  const worktree = await facetWorktree(pipeline, facet, prior, state);
  // A pooled port when the build has one; otherwise all facets share the live view under the lock.
  const handle = await acquirePreview(pipeline, facet.id);
  try {
    const result = await runFacetLoop(ctx, {
      ...facetLoopOptions(pipeline, facet, options),
      facetThreadId: facetThread.id ?? facetThread,
      facet: state?.spec ?? prior?.spec ?? facet,
      worktree,
      handle,
      previewLock: handle ? undefined : pipeline.previewLock,
      resumeState: state?.resume ?? null,
    });
    return await recordFacetResult(pipeline, facet, result, worktree);
  } finally {
    await releasePreview(ctx, handle);
  }
}

/**
 * The worktree a facet builds in. A resumed unfinished facet restarts from its last accepted
 * commit when it has one; otherwise from the run's starting point (the shared base).
 */
async function facetWorktree(
  pipeline: Pipeline,
  facet: AnyRecord,
  prior: AnyRecord | undefined,
  state: AnyRecord | null,
): Promise<string | null> {
  const { baseCommit, ctx, run, worktreeMode } = pipeline;
  if (!worktreeMode || state) return state?.worktree ?? prior?.worktree ?? null;
  const commit = prior?.lastCommit || baseCommit;
  const wt = await ctx.call(HostMethod.SnapshotWorktree, {
    project: run.project,
    ...(commit ? { commit } : {}),
    name: facet.id,
    runId: run.runId,
  });
  return wt.path;
}

/** What every facet's loop is told: the run, the game, the clock, the steering and the neighbours. */
function facetLoopOptions(pipeline: Pipeline, facet: AnyRecord, options: FacetRunOptions): AnyRecord {
  const { inbox, integration, ownShape, plan, progress, projectDir, report, run, seed, shape, threadId } = pipeline;
  return {
    runThreadId: threadId,
    run,
    ownsMain: !plan.mainOwner || plan.mainOwner === facet.id,
    shape,
    ownShape,
    seed,
    deadline: options.deadline,
    maxIterations: options.maxIterations,
    steering: () => pipeline.steering(facet.id),
    finishRequested: () => inbox.finishing(),
    integration,
    projectDir,
    onIteration: (record: AnyRecord) => {
      report.iterations.push(iterationForReport(record));
      progress.set(facet.id, Math.max(progress.get(facet.id) ?? 0, Number(record.iteration) || 0));
    },
    softCap: options.softCap,
    shouldYield: () => othersAwaitTheirCap(pipeline, facet, options.softCap),
    facets: plan.facets,
    routeDefect: pipeline.routeDefect,
    baseShots: pipeline.startEvidence?.shots ?? [],
  };
}

/** Is another unfinished facet still short of its round-one cap? Then this one yields. */
function othersAwaitTheirCap(pipeline: Pipeline, facet: AnyRecord, softCap: number | null | undefined): boolean {
  const { journal, plan, progress, softCaps } = pipeline;
  return plan.facets.some((f: AnyRecord) => {
    if (f.id === facet.id || journal.facets[f.id]?.done) return false;
    return (progress.get(f.id) ?? 0) < (softCaps.get(f.id) ?? softCap ?? Infinity);
  });
}

/** Journal a facet's result: a yield keeps its session for round two; a finish teaches the catalogue. */
async function recordFacetResult(
  pipeline: Pipeline,
  facet: AnyRecord,
  result: AnyRecord,
  worktree: string | null,
): Promise<AnyRecord> {
  const { catalogue, journal, plan, run, saveJournal } = pipeline;
  if (result.yielded) {
    pipeline.resumeStates.set(facet.id, { resume: result.resume, spec: result.spec, worktree });
    const { resume: _resume, ...journaled } = result;
    journal.facets[facet.id] = { ...journaled, worktree };
    await saveJournal();
    return { ...journaled, worktree };
  }
  journal.facets[facet.id] = result;
  pipeline.resumeStates.delete(facet.id);
  // What the facet learned goes to the catalogue: a check that failed on any judged
  // attempt caught a defect, and the plan's genres file it for the next game of that kind.
  recordCatalogueOutcomes(catalogue, result.spec, result.board, CheckOrigin.Planner, {
    runId: run.runId,
    genres: plan.genres ?? [],
    kind: run.game?.kind ?? null,
    everFailed: everFailedChecks(result),
  });
  await saveJournal();
  return result;
}

/** The checks that failed on any judged attempt of a facet. */
function everFailedChecks(result: AnyRecord): Set<string> {
  return new Set<string>(
    (result.attempts ?? []).flatMap((a: AnyRecord) =>
      (Object.entries(a.checks ?? {}) as Array<[string, unknown]>)
        .filter(([, pass]) => pass === false)
        .map(([id]) => id),
    ),
  );
}

/** Integrate: finish the continuous merges, then the merged build. */
async function integrateFacets(pipeline: Pipeline): Promise<PipelineEnd> {
  const { ctx, inbox, journal, run, saveJournal, threadId, worktreeMode } = pipeline;
  // ── integrate: finish the continuous merges, then the merged build gets its own loop ──
  if (await inbox.finishing())
    await appendRunEventStrict(ctx, threadId, RunEvent.RunControlApplied, {
      runId: run.runId,
      action: "finish",
      stage: "integrating",
      at: new Date().toISOString(),
    });
  journal.phase = JournalPhase.Integrate;
  await saveJournal();
  pipeline.conflicts = [];
  if (!worktreeMode) return;
  ctx.setStatus(`run ${run.runId} · integrating facets`);
  // Anything not yet on the integration branch (a facet that finished after its last CI
  // merge conflicted, or a run without an integration worktree) merges now.
  for (const facet of pipeline.plan.facets) await mergeFinishedFacet(pipeline, facet);
  if (pipeline.conflicts.length > 0 && !ctx.cancelled) await reconcileConflicts(pipeline);
  if (pipeline.integrationWorktree) {
    pipeline.integrationHead = await headOf(ctx, pipeline.integrationWorktree, {
      label: `autopilot:${run.runId}:ci:head`,
    }).catch(() => pipeline.integrationHead);
  }
}

/** Where the final merges land: the integration worktree, or the live folder without one. */
function mergeTarget(pipeline: Pipeline): string | { project: string } {
  return pipeline.integrationWorktree ? pipeline.integrationWorktree : { project: pipeline.run.project };
}

/** Merge one finished facet's last commit, unless the integration branch has it; a conflict is kept for the integrator. */
async function mergeFinishedFacet(pipeline: Pipeline, facet: AnyRecord): Promise<void> {
  const { ctx, journal, ownShape, run, shape, threadId } = pipeline;
  const result = journal.facets[facet.id];
  if (!isCommit(result?.lastCommit)) return;
  if (pipeline.integrationWorktree && (await isAncestor(ctx, pipeline.integrationWorktree, result.lastCommit))) return;
  const merge = await mergeNoFf(ctx, mergeTarget(pipeline), result.lastCommit, {
    message: `autopilot ${run.runId}: merge facet ${facet.id}`,
    label: `autopilot:${run.runId}:merge:${facet.id}`,
    failure: shortFailure,
    resolve: () =>
      unionMergeMain(
        (command) =>
          ctx.call(HostMethod.RunExec, {
            command,
            ...(pipeline.integrationWorktree ? { cwd: pipeline.integrationWorktree } : { project: run.project }),
            timeoutMs: GIT_TIMEOUT_MS.quick,
            label: `autopilot:${run.runId}:merge:union:${facet.id}`,
          }),
        {
          message: `autopilot ${run.runId}: merge facet ${facet.id} (union on FACET WIRING)`,
          main: shape.main,
          wiring: !ownShape,
        },
      ),
  });
  if (merge.ok && merge.union) {
    await appendRunEvent(ctx, threadId, RunEvent.IntegrationMerge, {
      runId: run.runId,
      facetId: facet.id,
      commit: result.lastCommit,
      conflict: false,
      union: true,
      stage: "final",
    });
    return;
  }
  if (!merge.ok) pipeline.conflicts.push({ facet, commit: result.lastCommit, output: merge.error });
}

/**
 * One integrator session fixes what plain merges could not, with the worktrees still on
 * disk as the source of truth for each facet's accepted state.
 */
async function reconcileConflicts(pipeline: Pipeline): Promise<void> {
  const { conflicts, ctx, deadline, journal, plan, report, run, threadId } = pipeline;
  const prompt = integratorBrief({ run, plan, conflicts, worktreeOf: (id) => journal.facets[id]?.worktree });
  try {
    if (pipeline.profile.delegated) {
      const conflictWorktrees = conflicts.map((c: AnyRecord) => journal.facets[c.facet.id]?.worktree).filter(Boolean);
      const effort = roleEffort(run, RoleKey.Builder);
      await ctx.call(HostMethod.EngineDelegate, {
        engine: roleEngine(run, RoleKey.Builder),
        prompt,
        project: run.project,
        ...(pipeline.integrationWorktree ? { cwd: pipeline.integrationWorktree } : {}),
        threadId,
        // The integrator writes code: a builder, on the builders' model.
        ...(run.model ? { model: run.model } : {}),
        ...(effort ? { effort } : {}),
        timeoutMs: Math.max(MIN_DELEGATE_TIMEOUT_MS, deadline - Date.now()),
        ...(conflictWorktrees.length ? { extraReads: conflictWorktrees } : {}),
      });
    }
    report.integratorConflicts = conflicts.map((c: AnyRecord) => c.facet.id);
    await commitReconciled(pipeline);
  } catch (err: any) {
    report.integratorError = err?.message ?? String(err);
  }
}

/**
 * The integrator is told to commit; the harness makes sure of it — uncommitted
 * reconciliation in a worktree would be lost to the next reset.
 */
async function commitReconciled(pipeline: Pipeline): Promise<void> {
  const { conflicts, ctx, run } = pipeline;
  const reconciled = mergeTarget(pipeline);
  const commitGit = { label: `autopilot:${run.runId}:integrator-commit`, timeoutMs: GIT_TIMEOUT_MS.quick };
  const message = `autopilot ${run.runId}: integrator reconciled ${conflicts.map((c: AnyRecord) => c.facet.id).join(", ")}`;
  await gitExec(ctx, reconciled, GIT.addAll, commitGit)
    .then((added) => (added?.code === 0 ? gitExec(ctx, reconciled, GIT.commitIfStaged(message), commitGit) : null))
    .catch(() => {});
}

/** The ledger before integration, then the integration facet's own scoreboard. */
async function judgeIntegration(pipeline: Pipeline): Promise<PipelineEnd> {
  const { catalogue, ctx, deadline, journal, ownShape, plan, projectDir, report, run, threadId, total } = pipeline;
  const { worktreeMode } = pipeline;
  // ── the ledger comes before integration: the merged build is judged first, and its defect
  // list is the integration facet's brief. Produced after the run, the same ledger was a
  // wasted judge call nobody could act on. ──
  const integrationFacet = integrationSpec(plan, journal.facets, { screen: !ownShape });
  pipeline.integrationFacet = integrationFacet;
  pipeline.integrationRoot = worktreeMode ? pipeline.integrationWorktree : projectDir;
  pipeline.ledger = null;
  const hasChecks = integrationFacet.checks.length > 0;
  const anythingBuilt = (Object.values(journal.facets) as AnyRecord[]).some((r) => r?.lastCommit || r?.iterations > 0);
  if (!ctx.cancelled && hasChecks && anythingBuilt) {
    const ended = await judgeMergedBuild(pipeline);
    if (ended) return ended;
  }
  // ── the integration facet: the merged build gets its own scoreboard and iterations ──
  // The integration facet needs real time left — five minutes on a run, a slice of a short run.
  pipeline.integrationRan = false;
  const timeLeft = deadline - Date.now() > Math.min(MIN_INTEGRATION_MS, total * INTEGRATION_CLOCK_SHARE);
  if (!ctx.cancelled && hasChecks && timeLeft) await runIntegrationFacet(pipeline);
  // A Stop in the merge, the ledger or the integration facet is a pause, like one in the facets;
  // past here the run would be judged, accepted and optimized as if it had finished.
  if (ctx.cancelled) {
    report.stoppedBecause = STOPPED_BY_USER;
    return { value: closeRun(ctx, { threadId, run, report, journal, catalogue }) };
  }
}

/** The merged build, judged against the starting point: its defects are the integration facet's brief. */
async function judgeMergedBuild(pipeline: Pipeline): Promise<PipelineEnd> {
  const { catalogue, ctx, journal, report, run, saveJournal, threadId } = pipeline;
  journal.phase = JournalPhase.Ledger;
  await saveJournal();
  ctx.setStatus(`run ${run.runId} · judging the merged build`);
  const handle = await acquirePreview(pipeline, LEDGER_LABEL);
  try {
    const mergedEvidence = await mergedBuildEvidence(pipeline, handle);
    // On the record beside the merges: does the merged build actually run? The stage offers a
    // build to the user mid-run, and takes one on by itself, only once something has looked.
    if (pipeline.worktreeMode && pipeline.integrationHead) {
      await appendRunEvent(ctx, threadId, RunEvent.IntegrationHealth, {
        runId: run.runId,
        head: pipeline.integrationHead,
        ok: mergedEvidence.ok === true,
        problems: (mergedEvidence.problems ?? []).slice(0, MERGED_PROBLEMS_KEPT),
      });
    }
    if (!mergedEvidence.ok) {
      report.ledgerError = `merged build not judgeable: ${mergedEvidence.problems.join("; ")}`;
      return;
    }
    await recordLedger(pipeline, mergedEvidence);
  } catch (err: any) {
    if (err?.kind === EngineFailure.Aborted || ctx.cancelled) {
      stopRun(report, StopCode.UserStop, STOPPED_BY_USER);
      return { value: closeRun(ctx, { threadId, run, report, journal, catalogue }) };
    }
    report.ledgerError = `ledger unavailable: ${err?.message ?? err}`;
  } finally {
    await releasePreview(ctx, handle);
  }
}

function mergedBuildEvidence(pipeline: Pipeline, handle: string | null): Promise<AnyRecord> {
  const { ctx, integrationFacet, run, seed, worktreeMode } = pipeline;
  return gatherEvidence(ctx, {
    run,
    iterationId: "merged",
    seed,
    ...(handle ? { handle } : {}),
    ...(worktreeMode && pipeline.integrationWorktree ? { root: pipeline.integrationWorktree } : {}),
    labelPrefix: "merged",
    cameras: integrationFacet.cameras,
    eyes: true,
    motion: 6,
    audio: true,
    maxDemos: Infinity,
  });
}

/** The ledger judge's verdict on the merged build, on the report and the record. */
async function recordLedger(pipeline: Pipeline, mergedEvidence: AnyRecord): Promise<void> {
  const { ctx, deadline, incumbent, integrationFacet, report, run, threadId } = pipeline;
  const verdict = await withProviderPatience(
    ctx,
    () =>
      blindCompare(ctx, {
        run,
        challenger: mergedEvidence,
        incumbentSnapshot: incumbent,
        incumbentEvidence: pipeline.startEvidence,
        iterationId: "merged",
        cameras: integrationFacet.cameras,
      }),
    {
      deadline,
      delays: outageDelays(run),
      label: "the ledger judge",
      onWait: (w) => providerOutage(ctx, run, { phase: OutagePhase.Ledger, ...w }),
    },
  );
  pipeline.ledger = { verdict, evidence: mergedEvidence };
  report.ledger = verdict.defects ?? [];
  await appendRunEvent(ctx, threadId, RunEvent.IntegrationLedger, {
    runId: run.runId,
    defects: verdict.defects ?? [],
    pick: verdict.pick,
    reason: verdict.reason ?? "",
  });
}

/** The integration facet: the merged build's own loop of rounds, fed the ledger's defects. */
async function runIntegrationFacet(pipeline: Pipeline): Promise<void> {
  const { ctx, journal, report, run, saveJournal, worktreeMode } = pipeline;
  journal.phase = JournalPhase.IntegrationFacet;
  await saveJournal();
  ctx.setStatus(`run ${run.runId} · integration facet`);
  const prior = journal.facets.integration;
  if (prior?.done) return;
  const facetThread =
    prior?.threadId ?? (await ctx.call(HostMethod.ThreadCreate, { title: `${run.runId} · Integration` }));
  const handle = await acquirePreview(pipeline, INTEGRATION_FACET);
  try {
    const result = await runFacetLoop(ctx, integrationLoopOptions(pipeline, facetThread.id ?? facetThread, handle));
    journal.facets.integration = result;
    report.facets.integration = result;
    report.integrationBoard = summarizeScoreboard(result.board, result.spec);
    pipeline.integrationRan = (result.attempts ?? []).some((a: AnyRecord) => a.won);
    if (worktreeMode && result.lastCommit) pipeline.integrationHead = result.lastCommit;
    await saveJournal();
  } finally {
    await releasePreview(ctx, handle);
  }
}

function integrationLoopOptions(pipeline: Pipeline, facetThreadId: string, handle: string | null): AnyRecord {
  const { deadline, inbox, integrationDefects, integrationFacet, journal, ownShape, projectDir, report, run } =
    pipeline;
  const { seed, shape, threadId, worktreeMode } = pipeline;
  return {
    runThreadId: threadId,
    facetThreadId,
    run,
    facet: integrationFacet,
    ownsMain: true,
    shape,
    ownShape,
    seed,
    worktree: worktreeMode ? pipeline.integrationWorktree : null,
    handle,
    previewLock: handle ? undefined : pipeline.previewLock,
    // The play check needs its six minutes even at the deadline (WP6).
    deadline: Math.max(deadline, Date.now() + INTEGRATION_PLAY_RESERVE_MS),
    maxIterations: Math.max(
      2,
      Math.round((run.budgets?.maxIterations ?? DEFAULT_MAX_ITERATIONS) * INTEGRATION_ITERATION_SHARE),
    ),
    // One integration/check attempt is still required when finishing; no further
    // improvement rounds after it. A request arriving mid-attempt lets that one land.
    finishRequested: async (attempts: number) => attempts > 0 && (await inbox.finishing()),
    steering: () => pipeline.steering(INTEGRATION_FACET),
    role: INTEGRATION_FACET,
    projectDir,
    extraReads: (Object.values(journal.facets) as AnyRecord[]).map((r) => r?.worktree).filter(Boolean),
    onIteration: (record: AnyRecord) => report.iterations.push(iterationForReport(record)),
    initialDefects: [...(pipeline.ledger?.verdict?.defects ?? []), ...integrationDefects].slice(0, MAX_INITIAL_DEFECTS),
    baseShots: pipeline.startEvidence?.shots ?? [],
  };
}

/** Land the integrated build in the live folder, and clean up the worktrees. */
async function landIntegrated(pipeline: Pipeline): Promise<PipelineEnd> {
  const { catalogue, ctx, journal, report, run, threadId, worktreeMode } = pipeline;
  // ── land the integrated build in the live folder ──
  const landable = worktreeMode && pipeline.integrationWorktree && isCommit(pipeline.integrationHead) && !ctx.cancelled;
  if (landable) {
    const land = await landIntegration(ctx, {
      project: run.project,
      head: pipeline.integrationHead,
      message: `autopilot ${run.runId}: integrated build`,
      label: `autopilot:${run.runId}:land`,
    });
    if (!land.ok) {
      // landIntegration has aborted the merge. The live folder sat at the base the whole time, so a conflict here is the user's own
      // evening of work. It used to be answered with `git reset --hard` onto the run's head,
      // which throws those commits away; the build waits on its integration ref instead, and
      // "Make it live" lands it when the folder is theirs to merge into.
      report.landing = "not landed: the merge conflicted with changes of your own in the game folder";
      // The run ends here: what the folder holds now is the user's, not this build,
      // so no verdict, acceptance, optimization or rollback may treat it as the run's.
      report.stoppedBecause = `${report.landing} — the integrated build waits on its ref`;
      await removeWorktrees(pipeline);
      return { value: closeRun(ctx, { threadId, run, report, journal, catalogue }) };
    }
  }
  if (worktreeMode) await removeWorktrees(pipeline);
}

/** Worktrees are done — clean up (their accepted commits live in the shared object store). */
async function removeWorktrees(pipeline: Pipeline): Promise<void> {
  const { ctx, journal, plan, run } = pipeline;
  const remove = (wt: string) =>
    ctx.call(HostMethod.SnapshotRemoveWorktree, { project: run.project, path: wt }).catch(() => {});
  for (const facet of [...plan.facets, { id: INTEGRATION_FACET }]) {
    const wt = journal.facets[facet.id]?.worktree;
    if (wt) await remove(wt);
  }
  if (pipeline.integrationWorktree) await remove(pipeline.integrationWorktree);
  for (const result of Object.values(journal.facets) as AnyRecord[]) {
    for (const spike of result?.spikes ?? []) {
      if (spike?.worktree) await remove(spike.worktree);
    }
  }
}

/** The global verdict: the integrated build against the base it forked from. */
async function judgeGlobally(pipeline: Pipeline): Promise<PipelineEnd> {
  const { catalogue, ctx, journal, report, run, saveJournal, threadId } = pipeline;
  // ── global verdict: the integrated build against the base it forked from, never the scaffold ──
  journal.phase = JournalPhase.Verdict;
  await saveJournal();
  ctx.setStatus(`run ${run.runId} · global verdict`);
  await snapshotIntegrated(pipeline);
  pipeline.finalEvidence = await finalEvidence(pipeline);
  if (!pipeline.finalEvidence.ok) return refuseUnjudgeable(pipeline);
  const lostDemos = lostDemosOf(pipeline);
  if (lostDemos.length) {
    pipeline.finalEvidence.warnings = [
      ...(pipeline.finalEvidence.warnings ?? []),
      `facet demos disappeared in integration — the merged build no longer exposes: ${lostDemos.join(", ")}`,
    ];
    report.lostDemos = lostDemos;
  }
  const integrationBoard = journal.facets.integration?.board ?? null;
  pipeline.integrationBoard = integrationBoard;
  pipeline.verdict = null;
  const ledgerStands =
    pipeline.ledger?.verdict &&
    pipeline.ledger.verdict.unusable !== true &&
    !pipeline.integrationRan &&
    !lostDemos.length;
  if (ledgerStands) {
    // Nothing changed since the merged build was judged: the ledger verdict IS the global
    // verdict, and the judge is not paid to look at the same frames twice.
    pipeline.verdict = { ...pipeline.ledger.verdict, iterationId: FINAL_ITERATION, reusedLedger: true };
  } else {
    try {
      pipeline.verdict = await globalVerdict(pipeline);
      // A judge that never gave usable JSON gave no verdict. Read as a tie it rolled the
      // whole integrated build back; as no verdict the run closes and the build stays unjudged.
      if (pipeline.verdict?.unusable === true) throw new Error(GLOBAL_JUDGE_UNUSABLE);
    } catch (err: any) {
      stopRun(report, StopCode.JudgeDown, `global judge unavailable: ${err?.message ?? err}`);
      return { value: closeRun(ctx, { threadId, run, report, journal, catalogue }) };
    }
  }
  report.globalVerdict = pipeline.verdict;
}

/** The integrated build, kept as a snapshot before anything judges it. */
async function snapshotIntegrated(pipeline: Pipeline): Promise<void> {
  const { ctx, report, run } = pipeline;
  try {
    const integratedSnapshot = await ctx.call(HostMethod.SnapshotCreate, {
      scope: "game",
      reason: `run ${run.runId}: integrated build, before the global verdict`,
      project: run.project,
      healthy: false,
    });
    report.integratedSnapshot = integratedSnapshot.snapshot_id;
  } catch {
    /* no snapshot: the verdict still judges the folder as it stands */
  }
}

/**
 * The final pass runs every demo and adds the user's-eye frame: the one picture with the
 * DOM on it, so a HUD the canvas never shows is seen at least once.
 * The last gate of the run forgives what the run inherited: the base's own errors (or,
 * failing that, the ones the game logged before the run began) are not this merge's fault.
 */
async function finalEvidence(pipeline: Pipeline): Promise<AnyRecord> {
  const { ctx, integrationFacet, run, seed, startingConsole } = pipeline;
  try {
    return await gatherEvidence(ctx, {
      run,
      iterationId: FINAL_ITERATION,
      seed,
      labelPrefix: FINAL_ITERATION,
      cameras: integrationFacet.cameras,
      eyes: true,
      motion: 6,
      audio: true,
      maxDemos: Infinity,
      userView: true,
      inheritedConsole: pipeline.startEvidence?.consoleBaseline ?? startingConsole,
    });
  } catch (err: any) {
    return lookThatThrew(err);
  }
}

/**
 * Final evidence whose gathering threw: the studio failed to look, which says nothing about the
 * build. Marked as such (`lookFailed`), not read back from its sentence: a thrown look once
 * counted as a broken build and rolled the whole run back.
 */
export function lookThatThrew(err: unknown): AnyRecord {
  return {
    ok: false,
    lookFailed: true,
    problems: [`final evidence failed: ${err instanceof Error ? err.message : String(err)}`],
    shots: [],
    state: null,
    stateEarly: null,
    consoleErrors: [],
    gpuErrors: [],
  };
}

/** Could the studio not look at the build, rather than the build not run? Then it is kept, unverdicted. */
export function unjudgedByObservation(evidence: AnyRecord): boolean {
  return evidence.lookFailed === true || observationOnlyFailure(evidence.problems);
}

/**
 * The integrated build could not be judged. An observation failure keeps it on disk, unverdicted;
 * a build failure is rolled back to the starting point, when the studio allows the restore.
 */
async function refuseUnjudgeable(pipeline: Pipeline): Promise<PipelineEnd> {
  const { catalogue, ctx, incumbent, journal, report, run, threadId } = pipeline;
  const problems = pipeline.finalEvidence.problems;
  if (unjudgedByObservation(pipeline.finalEvidence)) {
    stopRun(
      report,
      StopCode.ObservationDown,
      `final evidence was unusable (${problems.join("; ")}) — an observation failure, not a build failure; the integrated build is kept on disk, unverdicted`,
    );
    return { value: closeRun(ctx, { threadId, run, report, journal, catalogue }) };
  }
  stopRun(report, StopCode.NotJudgeable, `integrated build is not judgeable: ${problems.join("; ")}`);
  const rollback = await rollBackGame(ctx, {
    run,
    snapshot: incumbent,
    reason: `run ${run.runId}: integrated build broken — rolled back`,
  });
  report.rolledBack = rollback.rolledBack;
  if (!rollback.rolledBack)
    report.stoppedBecause += ` — the rollback was refused (${rollback.refusal}), so the integrated build is still in the game folder`;
  return { value: closeRun(ctx, { threadId, run, report, journal, catalogue }) };
}

/**
 * A facet's accepted demos must survive the merge: a build whose demos exist in their facets and
 * not in the integrated game would otherwise ship without anything saying so.
 * Compared against what the merged game DECLARES, not what a capped capture photographed:
 * the first v2 run reported three demos "lost" that all ran in the merged build.
 */
function lostDemosOf(pipeline: Pipeline): string[] {
  const { finalEvidence, journal } = pipeline;
  const mergedDemos = new Set(
    Array.isArray(finalEvidence.registeredDemos)
      ? finalEvidence.registeredDemos
      : (finalEvidence.shots ?? []).map((shot: AnyRecord) => String(shot.camera).replace(/^demo:/, "")),
  );
  pipeline.mergedDemos = mergedDemos;
  const lostDemos: string[] = [];
  pipeline.lostDemos = lostDemos;
  for (const [facetId, facetResult] of Object.entries(journal.facets ?? {}) as Array<[string, AnyRecord]>) {
    if (facetId === INTEGRATION_FACET) continue;
    for (const demo of facetResult?.demos ?? []) {
      const name = String(demo).replace(/^demo:/, "");
      if (!mergedDemos.has(name)) lostDemos.push(`${name} (facet ${facetResult.facetId})`);
    }
  }
  return lostDemos;
}

/**
 * The global verdict is the one call that must not die with a 529: the whole run's
 * work is judged here. A provider hiccup is waited out (about half an hour at most).
 */
function globalVerdict(pipeline: Pipeline): Promise<AnyRecord> {
  const { ctx, incumbent, integrationBoard, integrationFacet, run } = pipeline;
  const defects: AnyRecord[] = pipeline.ledger?.verdict?.defects ?? [];
  const extraContext = [
    integrationBoard
      ? `INTEGRATION SCOREBOARD (verified mechanically on the build under test):\n${renderScoreboard(integrationBoard)}`
      : "",
    defects.length
      ? `DEFECTS NAMED ON THE MERGED BUILD BEFORE INTEGRATION (say which are gone):\n${defects.map((d, i) => `${i + 1}. ${d}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return withProviderPatience(
    ctx,
    () =>
      blindCompare(ctx, {
        run,
        challenger: pipeline.finalEvidence,
        incumbentSnapshot: incumbent,
        incumbentEvidence: pipeline.startEvidence,
        iterationId: FINAL_ITERATION,
        cameras: integrationFacet.cameras,
        extraContext,
      }),
    {
      delays: outageDelays(run),
      label: "the global judge",
      onWait: (w) => providerOutage(ctx, run, { phase: OutagePhase.Final, ...w }),
    },
  );
}

/** Steering that came too late, the verified baseline, and the run's close. */
async function closePipeline(pipeline: Pipeline): Promise<PipelineEnd> {
  const { catalogue, ctx, finalDeadline, journal, projectDir, report, run, steeringBacklog, threadId } = pipeline;
  // Steering that arrived after the last builder hand-off is kept, said so, and heads the
  // next run's planner ask — never dropped in silence.
  await keepSteeringBacklog(ctx, { threadId, run, report, projectDir, backlog: await steeringBacklog() });
  const verifiedBaseline =
    pipeline.verdict.pick === VERDICT_CHALLENGER ? await acceptIntegrated(pipeline) : await rejectIntegrated(pipeline);
  if (verifiedBaseline) {
    await recordFinalization(pipeline, verifiedBaseline);
    await finalizeOptimization(ctx, { threadId, run, journal, report, deadline: finalDeadline });
  }
  return { value: closeRun(ctx, { threadId, run, report, journal, catalogue }) };
}

/**
 * The integrated build beat its base: it becomes the healthy snapshot, and the run says how it
 * ended — the reference panel's word when there is a reference, the facets' when there is none.
 */
async function acceptIntegrated(pipeline: Pipeline): Promise<AnyRecord> {
  const { ctx, plan, report, run } = pipeline;
  const winning = await ctx.call(HostMethod.SnapshotCreate, {
    scope: "both",
    reason: `run ${run.runId}: autopilot result accepted — ${pipeline.verdict.biggest_gap ?? ""}`,
    project: run.project,
    healthy: true,
  });
  report.finalSnapshot = winning.snapshot_id;
  // Decided on the facet's stop code, never on the words of its sentence (outcomes.ts).
  const deadEarly = (Object.entries(report.facets ?? {}) as Array<[string, AnyRecord]>).filter(([, r]) => diedEarly(r));
  const settledText = deadEarly.length
    ? `${deadEarly.length} of ${plan.facets.length} facets died early, their work unmerged (${deadEarly.map(([id, r]) => `${id}: ${r.stoppedBecause}`).join(" · ")})`
    : null;
  const hasReference = run.reference?.kind !== ReferenceKind.Direction && Boolean(run.reference?.name);
  if (hasReference) await judgeAgainstThePanel(pipeline, settledText);
  else stopRunUnlessStopped(report, StopCode.Done, settledText || "facets settled toward the direction");
  return winning;
}

/** The blind reference panel on the accepted build: victory, or why it was not one. */
async function judgeAgainstThePanel(pipeline: Pipeline, settledText: string | null): Promise<void> {
  const { ctx, integrationBoard, report, run } = pipeline;
  try {
    // The floor (WP7): until a calibrated threshold exists, "no worse than the base build"
    // on the best camera. A run that never measured the base has no floor to fail.
    const refs = referenceStats(run);
    const baseBest = bestStyleDistance(pipeline.startEvidence?.shots ?? [], refs);
    const finalBest = bestStyleDistance(pipeline.finalEvidence.shots ?? [], refs);
    report.styleDistance = { base: baseBest, final: finalBest };
    const panel = await withProviderPatience(
      ctx,
      () =>
        judgeAgainstReference(ctx, {
          run,
          evidence: pipeline.finalEvidence,
          iterationId: FINAL_ITERATION,
          styleFloor: baseBest?.distance ?? null,
          integrationBoard: integrationBoard ? renderScoreboard(integrationBoard) : null,
        }),
      {
        delays: outageDelays(run),
        label: "the reference panel",
        onWait: (w) => providerOutage(ctx, run, { phase: OutagePhase.Panel, ...w }),
      },
    );
    report.panel = panel;
    if (panel?.beatsReference) {
      report.victory = true;
      stopRun(
        report,
        StopCode.Victory,
        `the panel picked our build over ${run.reference?.name} (${panel.votes}${styleDistanceNote(panel.styleDistance)})`,
      );
      return;
    }
    stopRunUnlessStopped(
      report,
      StopCode.ReferenceUnbeaten,
      `${settledText ?? "facets settled"}; ${panelRefusal(run, panel)}`,
    );
  } catch (err: any) {
    stopRunUnlessStopped(
      report,
      StopCode.JudgeDown,
      `${settledText ?? "facets settled"}; reference panel unavailable (${err?.message ?? err})`,
    );
  }
}

/** "; style distance 0.42 on eye:spawn" — when the panel measured one. */
function styleDistanceNote(styleDistance: AnyRecord | null | undefined): string {
  const distance = styleDistance?.distance;
  if (distance === null || distance === undefined) return "";
  return `; style distance ${distance.toFixed(2)} on ${styleDistance?.camera}`;
}

/** Why the panel did not pick the build: the style floor, or its votes. */
function panelRefusal(run: Run, panel: AnyRecord | null | undefined): string {
  const style = panel?.styleDistance;
  if (style && style.ok === false)
    return `style distance ${style.distance?.toFixed(2)} is above the floor ${style.floor?.toFixed(2)}`;
  return `the panel still prefers ${run.reference?.name} (${panel?.votes ?? "no votes"})`;
}

/** The integrated build lost the global blind comparison: roll it back, and say whether that happened. */
async function rejectIntegrated(pipeline: Pipeline): Promise<null> {
  const { ctx, incumbent, report, run } = pipeline;
  const rollback = await rollBackGame(ctx, {
    run,
    snapshot: incumbent,
    reason: `run ${run.runId}: integrated build lost the global blind comparison`,
  });
  report.rolledBack = rollback.rolledBack;
  const after = rollback.rolledBack
    ? "rolled back"
    : `the rollback was refused (${rollback.refusal}), so the integrated build is still in the game folder`;
  stopRun(
    report,
    StopCode.NoImprovement,
    `the integrated build did not beat the base it forked from (${pipeline.verdict.biggest_gap ?? "no gap named"}) — ${after}`,
  );
  return null;
}

/** What the optimization pass starts from, saved in the journal so a resume can finish it. */
async function recordFinalization(pipeline: Pipeline, verifiedBaseline: AnyRecord): Promise<void> {
  const { ctx, incumbent, integrationFacet, journal, plan, report, run, threadId } = pipeline;
  const requiredChecks = (Object.entries(journal.facets) as Array<[string, AnyRecord]>).flatMap(([id, facet]) =>
    (Object.values(facet.board ?? {}) as AnyRecord[]).map((check) => ({ ...check, id: `${id}/${check.id}` })),
  );
  journal.finalization = withoutFrames({
    report,
    origin: FinalizationOrigin.Multi,
    baselineSnapshot: verifiedBaseline,
    baselineVerified: true,
    baselineEvidence: pipeline.finalEvidence,
    baselineVerdict: pipeline.verdict,
    startingSnapshot: incumbent,
    startingEvidence: pipeline.startEvidence,
    specs: [...plan.facets, integrationFacet],
    requiredChecks,
  });
  await writeJournal(ctx, threadId, run.runId, journal);
}

export { observationOnlyFailure } from "./evidence.ts";

/**
 * Put the game back on `snapshot` and say whether that happened. The studio refuses a restore
 * that would drop commits it did not make, and a run that could not roll back must not
 * report that it did.
 */
export async function rollBackGame(
  ctx: HarnessCtx,
  {
    run,
    snapshot,
    reason,
  }: { run: Pick<Run, "project">; snapshot: Pick<SnapshotRecord, "snapshot_id">; reason: string },
): Promise<{ rolledBack: boolean; refusal: string | null }> {
  try {
    await ctx.call(HostMethod.SnapshotRestore, {
      snapshotId: snapshot.snapshot_id,
      project: run.project,
      scope: "game",
      reason,
    });
    return { rolledBack: true, refusal: null };
  } catch (err: any) {
    return { rolledBack: false, refusal: err?.message ?? String(err) };
  }
}

/** A provider hiccup at run level, on the record: what waited, how long, why. */
function providerOutage(
  ctx: HarnessCtx,
  run: Pick<Run, "runId">,
  { phase, wait, attempt, error }: { phase: string; wait: number; attempt: number; error: unknown },
) {
  return appendRunEvent(ctx, ctx.threadId, RunEvent.AutopilotProviderOutage, {
    runId: run.runId,
    phase,
    wait,
    attempt,
    error,
  });
}

/** An iteration record as the report keeps it: everything but the frames. */
function iterationForReport(record: AnyRecord | null | undefined): AnyRecord {
  const { shots: _shots, diffs: _diffs, ...rest } = record ?? {};
  return rest;
}

async function keepSteeringBacklog(
  ctx: HarnessCtx,
  {
    threadId,
    run,
    report,
    projectDir,
    backlog,
  }: {
    threadId: string;
    run: Pick<Run, "runId">;
    report: AnyRecord;
    projectDir?: string | null;
    backlog?: string[] | null;
  },
): Promise<void> {
  if (!backlog?.length) return;
  report.steeringBacklog = backlog;
  if (projectDir) await writeSteeringBacklog(projectDir, backlog);
  await ctx
    .call(HostMethod.EventsAppend, {
      threadId,
      batch: backlog.map((item) => ({
        type: EventKind.Custom,
        event_type: RunEvent.AutopilotDecision,
        payload: {
          runId: run.runId,
          decision: `kept for the next run (arrived with no iteration left to build it): "${item}" — written to NOTES.md › Steering backlog and prepended to the next plan`,
          at: new Date().toISOString(),
        },
      })),
    })
    .catch(() => {});
}

/** Add the backlog's new items to the project's NOTES.md, under its steering backlog heading. */
async function writeSteeringBacklog(projectDir: string, backlog: readonly string[]): Promise<void> {
  const file = path.join(projectDir, "NOTES.md");
  const notes = await readFile(file, "utf8").catch(() => "");
  const existing = parseSteeringBacklog(notes);
  const fresh = backlog.filter((item) => !existing.includes(item));
  if (!fresh.length) return;
  const block = `${STEERING_BACKLOG_HEADING}\n\n${[...existing, ...fresh].map((item) => `- ${item}`).join("\n")}\n`;
  const next = notes.includes(STEERING_BACKLOG_HEADING)
    ? notes.replace(new RegExp(`${STEERING_BACKLOG_HEADING}[\\s\\S]*?(?=\\n## |$)`), block)
    : `${notes.trimEnd()}\n\n${block}`;
  await writeFile(file, next).catch(() => {});
}

async function closeRun(
  ctx: HarnessCtx,
  {
    threadId,
    run,
    report,
    journal,
    catalogue,
  }: { threadId: string; run: Run; report: AnyRecord; journal: AnyRecord; catalogue?: AnyRecord | null },
): Promise<AnyRecord> {
  // A user stop is a pause, not an ending: the journal keeps its live phase so Resume can
  // replay it, and the feed gets the paused card next to the honest closure.
  if (!report.optimization)
    report.optimization = await skipOptimization(ctx, {
      threadId,
      run,
      reason: ctx.cancelled
        ? "Run stopped before final optimization"
        : "Assembled game has not passed final verification",
    });
  const stoppedBeforeVerdict = ctx.cancelled && journal.phase !== JournalPhase.Verdict;
  const paused = stoppedBeforeVerdict || report.optimization?.outcome === OptimizationOutcome.Interrupted;
  journal.phase = paused ? JournalPhase.Paused : JournalPhase.Done;
  await writeJournal(ctx, threadId, run.runId, journal).catch(() => {});
  // The check catalogue learns from every run that closes: which checks were used, which passed.
  if (catalogue && (await learningOn(ctx))) await saveCatalogue(ctx.workspace, catalogue as Catalogue).catch(() => {});
  stopRunUnlessStopped(report, StopCode.Done, "autopilot finished");
  report.finishedAt = new Date().toISOString();
  await ctx.call(HostMethod.EventsAppend, {
    threadId,
    batch: [
      { type: EventKind.Custom, event_type: RunEvent.RunFinished, payload: report },
      ...(paused
        ? [
            {
              type: EventKind.Custom,
              event_type: RunEvent.AutopilotPaused,
              payload: { runId: run.runId, project: run.project },
            },
          ]
        : []),
    ],
  });
  await ctx.call(HostMethod.RunArtifact, {
    runId: run.runId,
    name: "report.json",
    base64: Buffer.from(JSON.stringify(report, null, 2)).toString("base64"),
  });
  return report;
}

function withoutFrames(value: unknown): any {
  return JSON.parse(JSON.stringify(value, (key, v) => (key === "base64" ? undefined : v)));
}
async function restoreFrames(evidence: AnyRecord | null | undefined): Promise<any> {
  if (!evidence) return evidence;
  const restored = structuredClone(evidence);
  for (const shot of [...(restored.shots ?? []), ...(restored.motion ?? [])]) {
    if (shot.path)
      shot.base64 = await readFile(shot.path)
        .then((b) => b.toString("base64"))
        .catch(() => null);
  }
  return restored;
}
async function finalizeOptimization(
  ctx: HarnessCtx,
  {
    threadId,
    run,
    journal,
    report,
    deadline,
  }: { threadId: string; run: Run; journal: AnyRecord; report: AnyRecord; deadline: number },
): Promise<void> {
  const f = journal.finalization;
  const baselineEvidence = await restoreFrames(f.baselineEvidence);
  const startingEvidence = await restoreFrames(f.startingEvidence);
  report.optimization = await runOptimization(ctx, {
    threadId,
    run,
    journal,
    deadline,
    origin: f.origin,
    baselineSnapshot: f.baselineSnapshot,
    baselineVerified: f.baselineVerified,
    baselineEvidence,
    baselineVerdict: f.baselineVerdict,
    specs: f.specs,
    requiredChecks: f.requiredChecks,
    quality: (bounded: HarnessCtx, { run: boundedRun, evidence }: { run: Run; evidence: AnyRecord }) =>
      optimizedQualityHolds(bounded, { run: boundedRun, evidence, finalization: f, startingEvidence, report }),
  });
  if (report.optimization.candidateAdopted) {
    if (report.optimizationQuality) report.globalVerdict = report.optimizationQuality;
    if (report.optimizationPanel) report.panel = report.optimizationPanel;
    const final = await ctx.call(HostMethod.SnapshotCreate, {
      scope: "game",
      project: run.project,
      healthy: true,
      reason: `run ${run.runId}: verified optimization retained`,
    });
    report.finalSnapshot = final.snapshot_id;
  }
  f.report = withoutFrames(report);
}

/**
 * Does the optimized build still beat the starting point (and the reference, when the run
 * beat it)? Same quality boundary as before the pass; an accepted change cannot reuse the ledger.
 */
async function optimizedQualityHolds(
  bounded: HarnessCtx,
  {
    run,
    evidence,
    finalization: f,
    startingEvidence,
    report,
  }: { run: Run; evidence: AnyRecord; finalization: AnyRecord; startingEvidence: AnyRecord; report: AnyRecord },
): Promise<boolean> {
  const fresh = await blindCompare(bounded, {
    run,
    challenger: evidence,
    incumbentSnapshot: f.startingSnapshot,
    incumbentEvidence: startingEvidence,
    iterationId: OPTIMIZATION_ITERATION,
    cameras: [...new Set<string>(f.specs.flatMap((s: AnyRecord) => s.cameras ?? []))],
  });
  if (fresh.pick !== VERDICT_CHALLENGER) return false;
  if (f.report?.panel?.beatsReference) {
    const panel = await judgeAgainstReference(bounded, {
      run,
      evidence,
      iterationId: OPTIMIZATION_ITERATION,
      styleFloor: f.report.panel.styleDistance?.floor ?? null,
    });
    if (!panel?.beatsReference) return false;
    report.optimizationPanel = panel;
  }
  // Same quality boundary as before the pass; an accepted change cannot reuse the ledger.
  report.optimizationQuality = fresh;
  return true;
}
