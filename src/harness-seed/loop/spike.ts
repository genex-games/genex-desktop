/**
 * Spikes — HARNESS-REWORK.md §4.4. When an identity check has failed two iterations running
 * (or the planner tagged it `hard`), the facet loop stops tuning parameters and opens a spike:
 * a throwaway mini-scene — one HTML page, the subsystem alone, the same check — built in its
 * own worktree with its own budget by a builder who is told only the check and the technique
 * classes already tried. A passing spike yields a recipe (code + check + evidence) that is
 * ported into the facet and stored in the technique library. Hard problems get solved in
 * isolation, early, and their solutions become durable knowledge.
 */
import { roleEffort, roleEngine, RoleKey, supportsSessions, toolCall } from "./model-roles.ts";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { gatherEvidence } from "./evidence.ts";
import { statePathsNamedByChecks } from "./state-shape.ts";
import { runDeterministicChecks } from "./checks.ts";
import { visionCheck } from "./judge.ts";
import { type Check, CheckKind, CheckWeight, demosNamedByChecks, type FacetSpec, renderChecks } from "./spec.ts";
import { recipeFromSpike, saveRecipe } from "./library.ts";
import { learningOn } from "./learning.ts";
import { buildTurn } from "./build-turn.ts";
import { parseSpikeVerdict, readSpikeVerdict } from "./replan.ts";
import { spikeRef } from "./repo.ts";
import { appendRun, RunEvent } from "./run-events.ts";
import { HostMethod } from "./host-methods.ts";
import { EngineFailure, StopReason } from "./outage.ts";
import { MINUTE_MS } from "./time.ts";
import { commitAll, updateRef } from "./git.ts";
import { GIT_TIMEOUT_MS, PAGE_SEED, RECIPE_ID_CHARS } from "./config.ts";
import { CLIP_BRIEF, CLIP_QUOTE } from "./text.ts";
import type { HarnessCtx, Run } from "../types/harness.d.ts";
import type { ProjectShape, SnapshotRecord } from "../types/host-api.d.ts";
import type { CheckResult } from "./checks.ts";
import type { Evidence } from "./evidence.ts";
import type { Recipe, RecipeHit } from "./library.ts";
import type { ExecAnswer, Trim } from "./git.ts";

/** Consecutive failures as an identity check that earn a check a spike. */
const SPIKE_CONSECUTIVE_FAILURES = 2;
/** The least time a spike gets, however close the deadline. */
const SPIKE_MIN_BUDGET_MS = 5 * MINUTE_MS;
/** The most time a spike gets, however far the deadline. */
const SPIKE_MAX_BUDGET_MS = 45 * MINUTE_MS;
/** The share of the facet's remaining time a spike may spend. */
const SPIKE_BUDGET_SHARE = 0.3;
/** How much of the spike's script a recipe keeps as its sketch when the recipe file has none. */
const RECIPE_SKETCH_CHARS = 6_000;
/** The longest name a spike's preview, thread and facet may take. */
const SPIKE_NAME_CHARS = 60;

/** A game's shape as a spike reads it: where it serves from, what builds it, its entry. */
type SpikeShape = Partial<Pick<ProjectShape, "serve" | "build" | "main">>;

/** Where a spike's page lives (spikeLocation). */
export interface SpikeLocation {
  dir: string;
  page: string;
  script: string;
  recipeFile: string;
  entry: string;
  contract: string;
  refused: string | null;
}

/** What one spike came to. */
export interface SpikeOutcome {
  checkId: string;
  ok: boolean;
  reason: string;
  branch: string | null;
  worktree: string | null;
  files: string[];
  recipe: Recipe | null;
  durationMs: number;
  unsatisfiable: string | null;
  /** The user stopped it: no verdict on the check, and nothing to replan. */
  stopped?: boolean;
}

/** What runSpike is handed by the facet loop. */
export interface SpikeOptions {
  run: Run;
  spec: FacetSpec;
  check: Check;
  worktree?: string | null;
  incumbentCommit?: string;
  tried?: string[];
  recipes?: RecipeHit[];
  handle?: string;
  deadline?: number | null;
  iteration: number;
  facetThreadId: string;
  ownsMain?: boolean;
  seed?: number;
  projectDir?: string | null;
  shape?: SpikeShape | null;
  ownShape?: boolean;
}

/** A check earns a spike after two consecutive failures as an identity check, or when tagged hard. */
export function spikeCandidates<C extends Pick<Check, "id" | "kind"> & { hard?: boolean; weight?: string }>(
  spec: { checks?: readonly C[] | null },
  failureStreaks: Record<string, number>,
  spiked: ReadonlySet<string>,
): C[] {
  return (spec.checks ?? []).filter((check) => {
    if (spiked.has(check.id)) return false;
    if (check.kind === CheckKind.Play) return false;
    if (check.hard) return true;
    return check.weight === CheckWeight.Identity && (failureStreaks[check.id] ?? 0) >= SPIKE_CONSECUTIVE_FAILURES;
  });
}

/**
 * The five keys the studio's own page carries. A spike page is served by the studio like any
 * other page, so it gets the vendored copies with no install and no bundler — and it gets them
 * spelled out here rather than told to copy a block out of a game whose index.html may be a
 * bundler's output, or may not exist as source at all.
 */
export const SPIKE_IMPORT_MAP = [
  '<script type="importmap">',
  "{",
  '  "imports": {',
  '    "three/webgpu": "/vendor/three.webgpu.js",',
  '    "three/tsl": "/vendor/three.tsl.js",',
  '    "three": "/vendor/three.module.js",',
  '    "three/addons/": "/vendor/three/examples/jsm/",',
  '    "three/": "/vendor/three/"',
  "  }",
  "}",
  "</script>",
].join("\n");

/**
 * Where a spike's page lives, and what the studio loads to look at it.
 *
 * On the template (and on any game the studio serves as written) that is `spike/` in the
 * workspace root. A game with a build serves its output folder, and a page written into the
 * source tree is never reached: `public/` is the one folder every bundler the studio has met
 * copies verbatim into that output, so the page goes there and is served at `spike/<id>.html`
 * all the same. A game with no build that still serves a subfolder gets the page in it.
 */
export function spikeLocation({
  id,
  shape = null,
  ownShape = false,
}: {
  id: string;
  shape?: SpikeShape | null;
  ownShape?: boolean;
}): SpikeLocation {
  const serve = String(shape?.serve ?? ".").replace(/\/+$/, "");
  const build = ownShape ? (shape?.build ?? null) : null;
  const at = (dir: string): SpikeLocation => ({
    dir,
    page: `${dir}/${id}.html`,
    script: `${dir}/${id}.js`,
    recipeFile: `${dir}/${id}.RECIPE.md`,
    // What `preview.load` is given: the page's path inside the folder the studio serves.
    entry: `spike/${id}.html`,
    contract: `${"../".repeat(dir.split("/").length)}src/studio.js`,
    refused: null,
  });
  if (build) {
    if (!shape?.serve) {
      return {
        ...at("spike"),
        refused: "this game builds into an output folder the studio cannot name, so a spike page could not be served",
      };
    }
    return at("public/spike");
  }
  const servesFromItsOwnFolder = ownShape && serve && serve !== ".";
  if (servesFromItsOwnFolder) return at(`${serve}/spike`);
  return at("spike");
}

export function spikeBrief({
  run,
  spec,
  check,
  tried,
  recipes,
  page,
  script,
  recipeFile,
  importMap = SPIKE_IMPORT_MAP,
  contract = "../src/studio.js",
  ownShape = false,
  build = null,
}: {
  run: Run;
  spec: Pick<FacetSpec, "title" | "intent">;
  check: Check;
  tried: string[];
  recipes: RecipeHit[];
  page: string;
  script: string;
  recipeFile: string;
  importMap?: string;
  contract?: string;
  ownShape?: boolean;
  build?: string | null;
}): string {
  return [
    `You are building a SPIKE inside Autopilot run ${run.runId} — a throwaway mini-scene that proves ONE technique against ONE check, in isolation from the game. Nothing you write here ships; the technique does.`,
    ``,
    `GAME GOAL (context only): ${run.goal}`,
    `FACET (context only): ${spec.title} — ${spec.intent.slice(0, CLIP_BRIEF)}`,
    ``,
    `THE ONE CHECK TO MAKE PASS:`,
    renderChecks([check]),
    ``,
    `BUILD EXACTLY THIS:`,
    `- ${page}: a page that carries this import map verbatim and loads ./${script.split("/").pop()} as a module. The studio serves this page itself, so the map's five keys resolve from its vendored three with no install and no bundler:\n${importMap}`,
    `- ${script}: builds ONLY the subsystem the check is about, with objects tagged (userData.tag) and cameras { default${check.camera && check.camera !== "default" ? `, ${check.camera}` : ""} } registered. Register them by calling installStudio({ scene, renderer, camera, player, cameras }) — import it from ${contract} if this game keeps the contract module there; if that import does not resolve, leave it out and just render: the studio puts its own code on every page it serves, so the harness can still see and photograph what your page draws.`,
    ownShape
      ? `- Do NOT edit the game: nothing under its own source folders, not its entry, not its page. The spike lives in ${page.slice(0, page.lastIndexOf("/"))}/ only, plus spike/VERDICT.md${build ? `. \`${build}\` must still build this game exactly as it does now — do not change what it does` : ""}.`
      : `- Do NOT edit src/, index.html or any file of the game. The spike lives in ${page.slice(0, page.lastIndexOf("/"))}/ only.`,
    tried.length ? `` : "",
    tried.length
      ? `TECHNIQUES ALREADY TRIED IN THE FACET AND KNOWN TO FAIL THIS CHECK — do not repeat them:\n${tried.map((t) => `- ${t}`).join("\n")}`
      : "",
    recipes.length ? `` : "",
    recipes.length
      ? `RECIPES THAT MAY APPLY:\n${recipes.map(({ recipe }) => `### ${recipe.title} (${recipe.id})\n${recipe.intent}\n${recipe.sketch ? "```js\n" + recipe.sketch.trim() + "\n```" : ""}`).join("\n\n")}`
      : "",
    ``,
    `LOOK: ${toolCall(roleEngine(run, RoleKey.Builder), "capture")} renders your spike page (${page}) and saves frames — capture after every change and Read the files. The check is evaluated mechanically by the harness on ${page} when you finish.`,
    ``,
    `WHEN THE CHECK PASSES, write ${recipeFile} with exactly these sections:`,
    `# <one-line title of the technique>`,
    `## Intent`,
    `<2–5 sentences: what the technique does and why the naive approach fails, with the numbers>`,
    `## Sketch`,
    "```js\n<the core of the technique, 10–40 lines, plain three.js>\n```",
    `## Port`,
    `<how to apply it in the facet's own files: which module, what to tag, what to expose>`,
    ``,
    `WHEN YOU FINISH, write spike/VERDICT.md with ONE line: \`passes\` if the check passes on ${page}, or \`unsatisfiable: <why>\` if the check cannot pass as written (a camera that cannot frame the subject, a helper whose shape the check misreads, a threshold no scene can hit). The harness reads that file: an honest "unsatisfiable" gets the check re-pointed by the planner; a silent failure costs the facet another iteration.`,
    `Finish with the check passing on ${page}. If you genuinely cannot make it pass, say so in VERDICT.md and in one line, and stop.`,
  ]
    .filter((line) => line !== undefined && line !== null)
    .join("\n");
}

/** `# title / ## Intent / ## Sketch / ## Port` → the recipe's fields. */
export function parseRecipeMarkdown(text: unknown): { title: string; intent: string; sketch: string; port: string } {
  const source = String(text ?? "");
  const title = /^#\s+(.+)$/m.exec(source)?.[1]?.trim() ?? "";
  const section = (name: string): string => {
    const re = new RegExp(`^##\\s+${name}\\s*$([\\s\\S]*?)(?=^##\\s+|\\s*$(?![\\s\\S]))`, "mi");
    return re.exec(source)?.[1]?.trim() ?? "";
  };
  const sketchBlock = /```(?:js|javascript)?\s*\n([\s\S]*?)```/.exec(section("Sketch") || source);
  return {
    title,
    intent: section("Intent"),
    sketch: sketchBlock?.[1]?.trim() ?? section("Sketch"),
    port: section("Port"),
  };
}

/** One spike as its steps share it: what it is for, where it lives, and what it has done so far. */
interface SpikeRun {
  ctx: HarnessCtx;
  options: SpikeOptions;
  id: string;
  label: string;
  location: SpikeLocation;
  started: number;
  spikeDeadline: number;
  outcome: SpikeOutcome;
  root: string | null;
  snapshot: SnapshotRecord | null;
}

/** How long a spike may take: a share of what the facet has left, within fixed bounds. */
function spikeBudget(deadline: number | null | undefined): number {
  const share = Math.round(((deadline ?? Date.now()) - Date.now()) * SPIKE_BUDGET_SHARE);
  return Math.max(SPIKE_MIN_BUDGET_MS, Math.min(SPIKE_MAX_BUDGET_MS, share));
}

/**
 * Run one spike. Worktree mode gets its own worktree at the incumbent commit; live mode (a
 * direct engine against the live folder) builds under `spike/` in the live folder. Returns the
 * outcome for the facet brief and, on a pass, the recipe that was saved.
 */
export async function runSpike(ctx: HarnessCtx, options: SpikeOptions): Promise<SpikeOutcome> {
  const { spec, check, deadline, iteration, shape = null, ownShape = false } = options;
  const id = check.id.replace(/[^a-z0-9-_]+/gi, "-");
  const location = spikeLocation({ id, shape, ownShape });
  const started = Date.now();
  const budgetMs = spikeBudget(deadline);
  const spike: SpikeRun = {
    ctx,
    options,
    id,
    label: `facet_${spec.id}/spike_${id}_${String(iteration).padStart(3, "0")}`,
    location,
    started,
    spikeDeadline: Math.min(deadline ?? Infinity, Date.now() + budgetMs),
    outcome: {
      checkId: check.id,
      ok: false,
      reason: "",
      branch: null,
      worktree: null,
      files: [location.page, location.script],
      recipe: null,
      durationMs: 0,
      unsatisfiable: null,
    },
    root: null,
    snapshot: null,
  };
  const delegated = await buildsInSessions(ctx, options.run);

  // A shape whose output folder the studio cannot name has nowhere to put a page the studio
  // could serve. Say that, once, instead of building a spike nobody can look at.
  if (location.refused) return finishedEarly(spike, `no spike: ${location.refused}`);

  await openSpikeWorkspace(spike, budgetMs);
  const built = await buildSpike(spike, delegated);
  if (built.stopped) {
    spike.outcome.stopped = true;
    return finishedEarly(spike, "stopped by the user");
  }
  const { result, error } = await checkSpike(spike, built.error);
  const passed = Boolean(result?.pass);
  spike.outcome.ok = passed;
  spike.outcome.reason = spikeReason(error, result);
  // The spike's own verdict (WP5): `spike/VERDICT.md`, else the builder's final message. An
  // honest "unsatisfiable" is worth more than a fourth identical failure — it opens a replan.
  if (!passed) spike.outcome.unsatisfiable = await spikeUnsatisfiable(spike, built.finalMessage);

  // ── keep the code, win or lose; a passing spike becomes a recipe ──
  if (passed) spike.outcome.recipe = await keepRecipe(spike);
  if (options.worktree && spike.root) await keepSpikeRef(spike, passed);
  const rollback = await rollBackLiveSpike(spike, passed);
  return closeSpike(spike, passed, rollback);
}

/** The run's builder engine keeps sessions, so a spike is a delegated build. */
async function buildsInSessions(ctx: HarnessCtx, run: Run): Promise<boolean> {
  const described = await ctx.call(HostMethod.EngineDescribe, {});
  const engineId = roleEngine(run, RoleKey.Builder);
  return supportsSessions(described.find((e) => e.id === engineId));
}

/** A spike that ends before its page is looked at: the reason, and how long it took. */
function finishedEarly(spike: SpikeRun, reason: string): SpikeOutcome {
  spike.outcome.reason = reason;
  spike.outcome.durationMs = Date.now() - spike.started;
  return spike.outcome;
}

/** The spike's own workspace: a worktree at the incumbent commit, or a snapshot of the live folder first. */
async function openSpikeWorkspace(spike: SpikeRun, budgetMs: number): Promise<void> {
  const { ctx, options, id } = spike;
  const { run, spec, check, worktree, incumbentCommit, tried = [], iteration, facetThreadId } = options;
  // ── the spike's own workspace ──
  if (worktree) {
    const wt = await ctx.call(HostMethod.SnapshotWorktree, {
      project: run.project as string,
      commit: incumbentCommit,
      name: `spike-${spec.id}-${id}`.slice(0, SPIKE_NAME_CHARS),
      runId: run.runId,
    });
    spike.root = wt.path;
    spike.outcome.worktree = spike.root;
  } else {
    spike.snapshot = await ctx.call(HostMethod.SnapshotCreate, {
      scope: "game",
      reason: `run ${run.runId} spike ${check.id}: before`,
      project: run.project as string,
      healthy: false,
    });
  }
  await appendRun(ctx, facetThreadId, RunEvent.FacetSpike, {
    runId: run.runId,
    facetId: spec.id,
    checkId: check.id,
    iteration,
    phase: "opened",
    budgetMs,
    tried,
  });
}

/** What the spike's build turn came to: an error, a stop, and the builder's last words. */
interface SpikeBuild {
  error: string | null;
  stopped: boolean;
  finalMessage: string;
}

/** The spike's build turn: delegated into its own seam, or a direct turn on the facet thread. */
async function buildSpike(spike: SpikeRun, delegated: boolean): Promise<SpikeBuild> {
  const { ctx, options } = spike;
  const { run, spec, check } = options;
  const turn = spikeTurn(spike);
  try {
    if (delegated) return await delegatedSpikeBuild(spike, turn);
    await buildTurn(ctx, {
      ...turn,
      delegated: false,
      metadata: { runId: run.runId, facetId: spec.id, iteration: options.iteration, phase: "spike", checkId: check.id },
      deadlineMs: spike.spikeDeadline,
    });
    return { error: null, stopped: false, finalMessage: "" };
  } catch (err: any) {
    const stopped = err?.kind === EngineFailure.Aborted || Boolean(ctx.cancelled);
    return { error: err?.message ?? String(err), stopped, finalMessage: "" };
  }
}

/** The spike's build turn as both engines take it: the brief, on the facet thread, at the builder's own effort. */
function spikeTurn(spike: SpikeRun) {
  const { options, location } = spike;
  const { run, spec, check, tried = [], recipes = [], facetThreadId, shape = null, ownShape = false } = options;
  const brief = spikeBrief({
    run,
    spec,
    check,
    tried,
    recipes,
    page: location.page,
    script: location.script,
    recipeFile: location.recipeFile,
    contract: location.contract,
    ownShape,
    build: ownShape ? (shape?.build ?? null) : null,
  });
  // The builder works on exactly the run's builder effort, even none.
  return {
    engine: roleEngine(run, RoleKey.Builder),
    prompt: brief,
    project: run.project,
    threadId: facetThreadId,
    runId: run.runId,
    model: run.model,
    effort: roleEffort(run, RoleKey.Builder),
  };
}

/** A delegated spike build, owning only its own folder and the verdict file. */
async function delegatedSpikeBuild(spike: SpikeRun, turn: ReturnType<typeof spikeTurn>): Promise<SpikeBuild> {
  const { ctx, options, id, location, root } = spike;
  const { run, spec, handle, iteration, projectDir = null, shape = null, ownShape = false } = options;
  const facetId = `${spec.id}-spike-${id}`.slice(0, SPIKE_NAME_CHARS);
  const delegation = await buildTurn(ctx, {
    ...turn,
    delegated: true,
    cwd: root,
    timeoutMs: spike.spikeDeadline - Date.now(),
    delegation: {
      selfCapture: {
        project: run.project,
        root: root ?? projectDir ?? "",
        runId: run.runId,
        facetId,
        iteration,
        entry: location.entry,
        ...(handle ? { handle } : {}),
      },
      // A spike had no ownership at all on either engine: the brief said "do not edit the
      // game" and nothing enforced it. Its seam is its own folder and the verdict file.
      ownership: {
        facetId,
        owns: [location.dir, "spike/VERDICT.md"],
        ownsMain: false,
        ...(ownShape ? { template: false } : {}),
        ...(ownShape && shape?.serve && shape.serve !== "." ? { neverLock: [shape.serve] } : {}),
        ...(ownShape && shape?.main ? { main: shape.main, studio: "src/studio.js" } : {}),
      },
    },
  });
  const error = delegation.ok ? null : delegation.errorText || delegation.stopReason || "spike build did not finish";
  // A contractor the user stopped reports it, not a throw: the spike stops with it.
  const stopped = delegation.stopReason === StopReason.Stopped || Boolean(ctx.cancelled);
  return { error, stopped, finalMessage: String(delegation.summary ?? "") };
}

/** The one check, on the spike page: its result, or the error that kept it from being read. */
async function checkSpike(
  spike: SpikeRun,
  buildError: string | null,
): Promise<{ result: CheckResult | null; error: string | null }> {
  if (buildError) return { result: null, error: buildError };
  let evidence: Evidence;
  try {
    evidence = await spikeEvidence(spike);
  } catch (err: any) {
    return { result: null, error: `spike evidence failed: ${err?.message ?? err}` };
  }
  if (evidence.problems?.length && !evidence.shots?.length)
    return { result: null, error: `spike page does not run: ${evidence.problems.join("; ")}` };
  // An empty build error is still the reason the outcome gives, as it always was.
  return { result: await spikeCheckResult(spike, evidence), error: buildError };
}

/** The spike page's evidence: the check's camera only, and the demo it names if any. */
async function spikeEvidence(spike: SpikeRun): Promise<Evidence> {
  const { ctx, options, label, location, root } = spike;
  const { run, check, handle, iteration, seed = PAGE_SEED } = options;
  return gatherEvidence(ctx, {
    run,
    iterationId: `spike-${iteration}`,
    seed,
    ...(handle ? { handle } : {}),
    ...(root ? { root } : {}),
    entry: location.entry,
    labelPrefix: label,
    cameras: [check.camera ?? "default"],
    eyes: false,
    motion: 0,
    audio: false,
    maxDemos: 1,
    // The spike exists for this one check: if it names a demo, that demo runs.
    requiredDemos: demosNamedByChecks([check]),
    keepPaths: statePathsNamedByChecks([check]),
  });
}

/** Evaluate the check on the spike's evidence: a vision question on its (cropped) frame, or the harness's own. */
async function spikeCheckResult(spike: SpikeRun, evidence: Evidence): Promise<CheckResult | null> {
  const { ctx, options } = spike;
  const { run, check, handle } = options;
  if (check.kind !== CheckKind.Vision) {
    const { results } = await runDeterministicChecks(ctx, { spec: { checks: [check] }, evidence, handle });
    return results[0] ?? null;
  }
  return visionCheck(ctx, { run, check, crop: await spikeCrop(spike, evidence) });
}

/** The frame a vision check on the spike asks about, cropped when the check names a crop. */
async function spikeCrop(
  spike: SpikeRun,
  evidence: Evidence,
): Promise<{ base64?: string; path?: string | null } | null> {
  const { ctx, options, id, label } = spike;
  const { run, check, handle } = options;
  const shot = (evidence.shots ?? []).find((s) => s.camera === (check.camera ?? "default"));
  if (!shot) return null;
  const whole = { base64: shot.base64, path: shot.path };
  if (!check.crop) return whole;
  const cropped = await ctx
    .call(HostMethod.PreviewCrop, {
      runId: run.runId,
      path: shot.path as string,
      crop: check.crop,
      label: `${label}/crops/${id}`,
      ...(handle ? { handle } : {}),
    })
    .catch(() => null);
  return cropped?.base64 ? cropped : whole;
}

/** The outcome's one-line reason. */
function spikeReason(error: string | null, result: CheckResult | null): string {
  if (error !== null) return error;
  if (!result) return "no result";
  return result.pass ? "check passed on the spike page" : `check still fails: ${result.reason}`;
}

/** The spike builder's own "unsatisfiable", from `spike/VERDICT.md` or its final message. */
async function spikeUnsatisfiable(spike: SpikeRun, finalMessage: string): Promise<string | null> {
  const verdict =
    (await readSpikeVerdict(spike.root ?? spike.options.projectDir ?? null)) ?? parseSpikeVerdict(finalMessage);
  if (verdict?.verdict !== "unsatisfiable") return null;
  return verdict.reason || "the spike builder reports the check cannot pass as written";
}

/** The recipe file the builder wrote, wherever it put it. */
async function readRecipeMarkdown(base: string, spike: SpikeRun): Promise<string> {
  const { id, location } = spike;
  const candidates = [
    location.recipeFile,
    path.join("spike", `${id}.RECIPE.md`),
    path.join(location.dir, `${id}.RECIPE.md`),
  ];
  for (const file of candidates) {
    const markdown = await readFile(path.join(base, file), "utf8").catch(() => "");
    if (markdown) return markdown;
  }
  return "";
}

/** A passing spike's technique, as a recipe — saved to the library when learning is on. */
async function keepRecipe(spike: SpikeRun): Promise<Recipe> {
  const { ctx, options, id, location } = spike;
  const { run, spec, check, iteration } = options;
  const base = spike.root ?? options.projectDir ?? null;
  const parsed = parseRecipeMarkdown(base ? await readRecipeMarkdown(base, spike) : "");
  let sketch = parsed.sketch;
  if (!sketch && base)
    sketch = (await readFile(path.join(base, location.script), "utf8").catch(() => "")).slice(0, RECIPE_SKETCH_CHARS);
  // An id is always given, so the recipe is always made.
  const recipe = recipeFromSpike({
    id: `spike.${spec.id}.${id}`.slice(0, RECIPE_ID_CHARS),
    check,
    tags: [check.id, check.kind, spec.id],
    intent: parsed.intent || parsed.title || `Technique that satisfies ${check.id}, proven in a spike.`,
    sketch,
    port:
      parsed.port ||
      `Port ${location.script} into the facet's own module; keep the tags and the camera the check names.`,
    evidence: { run: run.runId, project: run.project, facet: spec.id, iteration, spike: id, check: check.id },
    // Proven in one game: project-scoped until it wins in another.
    project: run.project,
  }) as Recipe;
  if (parsed.title) recipe.title = parsed.title.slice(0, CLIP_QUOTE);
  // This run's round uses the technique either way; keeping it for later games is learning.
  if (await learningOn(ctx)) await saveRecipe(ctx.workspace, recipe);
  return recipe;
}

/** Commit the spike's worktree and keep it on a ref, win or lose. */
async function keepSpikeRef(spike: SpikeRun, passed: boolean): Promise<void> {
  const { ctx, options, id, outcome } = spike;
  const { run, spec } = options;
  const root = spike.root as string;
  try {
    const at = {
      label: `spike:${spec.id}:${id}:git`,
      timeoutMs: GIT_TIMEOUT_MS.quick,
      trim: "both" as Trim,
      failure: (exec: ExecAnswer) => (exec.stderr || exec.stdout) as string,
    };
    await commitAll(
      ctx,
      root,
      `spike ${spec.id}/${id}: ${passed ? "passed" : "did not pass"} — ${outcome.reason.slice(0, CLIP_QUOTE)}`,
      { allowEmpty: true, ...at },
    );
    // A ref, not a branch: the technique stays reachable without appearing in the user's
    // `git branch` the next morning.
    const ref = spikeRef(run.runId, spec.id, id);
    await updateRef(ctx, root, ref, "HEAD", at);
    outcome.branch = ref;
  } catch {
    /* the recipe (if any) is already saved; the ref is a convenience */
  }
}

/**
 * A failed live-mode spike leaves nothing behind — but the folder is the user's, and whatever
 * it gained during the spike window is kept in an attempt snapshot first. No attempt kept, no
 * rollback: the spike's files stay where they are rather than take anything else with them.
 */
async function rollBackLiveSpike(
  spike: SpikeRun,
  passed: boolean,
): Promise<{ attemptSnapshot: SnapshotRecord | null; rolledBack: boolean }> {
  const { ctx, options, snapshot } = spike;
  const { run, check } = options;
  const kept = { attemptSnapshot: null, rolledBack: false };
  const nothingToKeep = options.worktree || passed || !snapshot;
  if (nothingToKeep) return kept;
  const attemptSnapshot = await ctx
    .call(HostMethod.SnapshotCreate, {
      scope: "game",
      reason: `run ${run.runId} spike ${check.id}: attempt`,
      project: run.project,
      healthy: false,
    })
    .catch(() => null);
  if (!attemptSnapshot) return kept;
  const rolledBack = await ctx
    .call(HostMethod.SnapshotRestore, {
      snapshotId: snapshot.snapshot_id,
      project: run.project,
      scope: "game",
      reason: `run ${run.runId} spike ${check.id}: did not pass`,
    })
    .then(
      () => true,
      () => false,
    );
  return { attemptSnapshot, rolledBack };
}

/** Record the spike's close on the facet thread, tell the screen, and hand the outcome back. */
async function closeSpike(
  spike: SpikeRun,
  passed: boolean,
  { attemptSnapshot, rolledBack }: { attemptSnapshot: SnapshotRecord | null; rolledBack: boolean },
): Promise<SpikeOutcome> {
  const { ctx, options, outcome, snapshot } = spike;
  const { run, spec, check, iteration, facetThreadId } = options;
  outcome.durationMs = Date.now() - spike.started;
  await appendRun(ctx, facetThreadId, RunEvent.FacetSpike, {
    runId: run.runId,
    facetId: spec.id,
    checkId: check.id,
    iteration,
    phase: "closed",
    ok: passed,
    reason: outcome.reason,
    branch: outcome.branch,
    recipe: outcome.recipe?.id ?? null,
    durationMs: outcome.durationMs,
    unsatisfiable: outcome.unsatisfiable,
    ...(snapshot ? { attemptSnapshot: attemptSnapshot?.snapshot_id ?? null, rolledBack } : {}),
  });
  ctx.notify("autopilot.spike", {
    runId: run.runId,
    facetId: spec.id,
    checkId: check.id,
    ok: passed,
    reason: outcome.reason,
  });
  return outcome;
}

/** The one-paragraph summary a facet brief carries after a spike. */
export function describeSpike(outcome: SpikeOutcome | null | undefined): string | null {
  if (!outcome) return null;
  if (outcome.ok) {
    return [
      `A spike SOLVED check ${outcome.checkId}${outcome.branch ? ` (kept on ${outcome.branch}${outcome.worktree ? `, worktree ${outcome.worktree}` : ""})` : ""}.`,
      `Port it now: the technique is in ${outcome.files.join(" and ")} there, and as recipe "${outcome.recipe?.title ?? outcome.recipe?.id}" below. Do not re-derive it.`,
    ].join(" ");
  }
  if (outcome.unsatisfiable)
    return `A spike on check ${outcome.checkId} reported it UNSATISFIABLE as written (${outcome.unsatisfiable}). The planner is re-pointing the check; do not spend this iteration on it.`;
  return `A spike on check ${outcome.checkId} did NOT pass (${outcome.reason}). Its attempt is kept${outcome.branch ? ` on ${outcome.branch}` : ""}; try a different technique class.`;
}
