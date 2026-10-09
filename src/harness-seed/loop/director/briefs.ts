import { durationCommission, goalCommission } from "./commission.ts";
import { workersAtOnce } from "./foundation.ts";
/**
 * The briefs the run's sessions open with, as the model reads them: the director's own, the
 * wrap-up prompt, a single-session worker's and the one that makes somebody's own game
 * judgeable. Only the assembly lives here; the facts come from the caller.
 */
import { lastTimeBlock } from "../ledger.ts";
import { roleEngine, RoleKey, toolCall, toolSyntax } from "../model-roles.ts";
import { contractWiringAsk } from "../prompts-build.ts";
import { facetNotes, runRef } from "../repo.ts";
import { shortSha } from "../git.ts";
import { isRunning } from "../outcomes.ts";
import { KIND_NAMES } from "../kinds.ts";
import { minutes } from "../time.ts";
import { LEAD_BRIEF, LEAD_RESUMED_MEMORY } from "./lead-session-prompts.ts";
import { MAX_DIRECTOR_MEMORY } from "./memory.ts";
import { DIRECTOR_TOOLS } from "./tool-specs.ts";
import { WAKE_BRIEF, wakeTools } from "./wake-prompts.ts";
import { DirectorLoop } from "./wake-schedule.ts";
import { workingGoal } from "../goal-prompts.ts";
import { DIRECTOR_SCOPE_RULE, scopeLines } from "../scope-prompts.ts";
import { visionBriefLines } from "../vision-prompts.ts";
import { SHIP_DEFECTS_NOT_POLISH } from "./art-direction-prompts.ts";
import type { AnyRecord, Run } from "../../types/harness.d.ts";
// Type-only: erased at runtime, so this module still imports no part of the run.
import type { Worker } from "./loop-run.ts";

/**
 * This part serves a lead that is its chat's own session (one session): it builds in the integration
 * worktree by its full path and keeps no memory file. A run seats one only when every part it
 * depends on says so (lead-session.ts `servesLead`).
 */
export const SERVES_LEAD = true;

/**
 * The pool is a ceiling, not a quota: the fewest workers that cover independent files. A lead told
 * that an idle window is time lost fills it with something nobody asked for; the wake digest's room
 * line says where more goes (a deeper layer of an in-scope area). Short, because the brief's own
 * words are bounded.
 */
const CAPACITY_RULE = "A ceiling, not a quota: start the fewest workers that cover independent files.";

/** A brief's lines, with the ones a condition left empty taken out. */
const joinLines = (lines: ReadonlyArray<string | null | undefined>): string =>
  lines.filter((line) => line !== null && line !== undefined && line !== "").join("\n");

/**
 * The brief for the one session that makes somebody's own game judgeable (M2.6). A game that
 * arrived without the studio contract answers nothing: no state, no cameras, no capture — every
 * judge reads "the build does not run", the fork gate refuses every builder, and there is no
 * "before" for `judge against=start` to compare with. The first real run spent its opening
 * hour with the lead hand-wiring it in its own worktree because nobody had been given the job.
 *
 * It is the base builder's own-shape wiring task and nothing else (autopilot.ts
 * `contractWiringAsk` is the shared sentence): no content, no cleanup, no restyling of a game
 * the user already has and did not ask anyone to touch.
 */
export function contractBrief({
  run,
  projectLabel,
  shape = null,
}: {
  run: Run;
  projectLabel: string;
  shape?: AnyRecord | null;
}): string {
  const entryMain = shape?.main ?? "src/main.js";
  return [
    `You are making the game "${projectLabel}" judgeable for run ${run.runId}, in an isolated copy of it (this folder). This is your only job: nothing in this game can be looked at, checked or compared until its page loads the studio contract.`,
    ``,
    `GAME GOAL (context — not this run's work): ${workingGoal(run)}`,
    scopeLines(run),
    ``,
    `THIS GAME HAS ITS OWN SHAPE — it is not the studio's template. Its entry is ${entryMain}${shape?.build ? `, its page is built with \`${shape.build}\`` : ""} and the studio serves ${shape?.entry ?? "index.html"}. Keep all of it: no second entry, do not replace index.html, do not rewrite the game, do not restyle or "clean up" anything.`,
    ``,
    `DO EXACTLY THIS:`,
    `- ${contractWiringAsk(shape)}`,
    `- The contract's types are in src/studio.d.ts beside it: if the compiler rejects ./studio.js, use them — never drop the import.`,
    ...(shape?.build
      ? [
          `- Run \`${shape.build}\` yourself and fix every error it reports: the studio runs the same build before every window loads, so a build that fails is a black screen for every judge.`,
        ]
      : []),
    `- Change nothing else. No features, no content, no refactors — the run's builders do that next, and they fork from what you leave here.`,
    `- Do not commit; the studio commits.`,
    ``,
    `YOU HAVE HANDS AND EYES: ${toolCall(roleEngine(run, RoleKey.Builder), "computer")} runs this folder's build in its own window; the tool's own description lists every action it takes. Look before you finish: window.__studio.state() must answer, and the game must still look and play exactly as it did.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** What a director brief is built from. */
export interface DirectorBriefFacts {
  run: Run;
  shape?: AnyRecord | null;
  ownShape?: boolean;
  capacity?: AnyRecord | null;
  skill?: string;
  softDeadline: number;
  finalDeadline: number;
  resume?: string | null;
  integrationWorktree: string;
  baseCommit: string | null;
  nestedRepos?: string[];
  startingPoint?: AnyRecord | null;
  startObserved?: boolean;
  gameLessons?: string[];
  contract?: AnyRecord | null;
  /** How the session is driven: a waking lead is told it ends its turn and has no `wait` (default: the long turn's words). */
  loop?: DirectorLoop;
  /**
   * A lead that is its chat's own session (one session): where it sits. It reads the lines written
   * for a lead, which builds in the integration worktree by its full path; absent, a director whose
   * cwd is `integrationWorktree`.
   */
  lead?: { gameFolder: string } | null;
}

/**
 * The pool as the brief states it: how many workers may run at once (the user's Maximum
 * concurrent workers — the pool less the lead's own two windows) and the memory free, or that
 * nobody knows — never the raw window count, which overstates what workers can use.
 */
function poolWords(capacity: AnyRecord | null): string {
  if (!capacity?.max) return "the pool size is unknown";
  const atOnce = workersAtOnce(capacity);
  return `up to ${atOnce} workers at once (the user's setting; two more windows are yours), ${capacity.memory?.freeMb ?? "?"} MB memory free`;
}

/** The reference or direction the run is about, when it has one. */
function referenceLine(run: Run): string {
  const reference = run.reference;
  if (!reference?.name) return "";
  const notes = reference.notes ? ` — ${reference.notes}` : "";
  const stills = reference.frames?.length
    ? ` (${reference.frames.length} reference still(s) attached to this message)`
    : "";
  return `REFERENCE / DIRECTION: ${reference.name}${notes}${stills}`;
}

/** Whose shape the game has: its own (and the seam rule that follows from it), or the studio's template. */
function shapeLine(ownShape: boolean, shape: AnyRecord | null): string {
  if (!ownShape)
    return `THIS GAME IS ON THE STUDIO TEMPLATE: index.html → src/main.js, src/studio.js is the contract (installStudio, cameras, demos, probes, the FACET WIRING block in main.js).`;
  return `THIS GAME HAS ITS OWN SHAPE: entry ${shape?.main ?? "src/main.ts"}${shape?.build ? `, built with \`${shape.build}\`` : ""}; the studio serves ${shape?.entry ?? "index.html"} and builds it before every window loads. Keep its entry, its UI and its input handling; the studio contract (src/studio.js, installStudio) must stay wired so every window, judge and check can see it.\nTHIS IS THE USER'S OWN CODE, NOT THE STUDIO'S TEMPLATE: there is no FACET WIRING block in its entry and no module-per-worker convention to fall back on. Every worker you start here gets a SEAM — owns= with files, folders or a quoted glob — in the structure the game already has; a worker with no seam may edit anything but the entry, the contract and index.html, so start one of those only when nobody else is running, and never two owners of the entry at once.`;
}

/** The state the run is about, when the game does not boot into it. */
function requestedStateLine(setup: AnyRecord | null | undefined): string {
  if (!setup) return "";
  const how = setup.note ?? (setup.demo ? `demo "${setup.demo}"` : `${(setup.actions ?? []).length} input action(s)`);
  const verified = setup.verify ? `, verified by ${setup.verify.path}` : "";
  return `THE REQUESTED STATE: the run is about a state the game does not boot into; the studio replays a setup script after every load (${how})${verified}. Workers may carry their own setup.`;
}

/**
 * What the run owes this game before anything else: a page that never loads the studio
 * contract cannot be judged at all, so the studio wires it in first (M2.6) — and says so
 * here whether that worked, because the fallback is the lead doing it with its own hands.
 */
function contractLine(contract: AnyRecord | null, shape: AnyRecord | null, leads: boolean): string {
  if (contract?.ok && contract?.attached)
    return `THE GAME IS JUDGEABLE NOW: nothing in its sources installs the studio contract, but the studio attaches to its page on its own — it watches the frames the game draws and finds the renderer, the scene and the camera from them. Nothing was wired and nothing about the game was changed. If a build ever stops being readable, the fix is the two lines: \`import { installStudio } from "./studio.js"\` and \`installStudio({ renderer, player })\` in ${shape?.main ?? "the entry"}.`;
  if (contract?.ok)
    return `THE GAME IS JUDGEABLE NOW: it arrived without the studio contract, so the studio wired it into ${shape?.main ?? "its entry"} and committed it (${shortSha(contract.commit ?? "")}) before your session opened. That commit is what "start" means for this run and what every worker forks from — keep it wired, and nothing else about the game was touched.`;
  if (contract && leads) return LEAD_BRIEF.contractFailed(contract.error, shape?.main ?? "the entry");
  if (contract)
    return `CONTRACT NOT INSTALLED — DO THIS FIRST: this game's page never loads the studio contract, and the studio's own attempt to wire it in failed (${contract.error}). Until it is wired nothing can be judged: no state, no cameras, no capture, and worker_start refuses every fork. Before you plan anything, read ${shape?.main ?? "the entry"}: if the call is already there, say so in a note and carry on; otherwise ${contractWiringAsk(shape)} Then look at it with capture, and commit. Change nothing else about the game.`;
  return "";
}

/** A start nobody could photograph, when the studio did not build one either. */
function unobservedStartLine(startObserved: boolean, startingPoint: AnyRecord | null): string {
  if (startObserved || startingPoint) return "";
  return `THE START COULD NOT BE OBSERVED: the game as this run found it drew nothing a camera could see, so there is no "before" to compare with — \`judge against=start\` will say so. Judge a build on its own evidence (checks, a question) or against another build, and do not spend calls on the comparison.`;
}

/**
 * The foundation a run with room for a team lays itself (foundation.ts `foundationFirst`): no starting
 * scene was built, so the lead writes the contract, the vision and crude stubs, and each part's
 * owner builds the content.
 */
function foundationLine(leads: boolean): string {
  const where = leads ? "yourself in the integration worktree by its full path" : "in your worktree";
  return `THE FOUNDATION IS YOURS: this game is an empty project and this run has room for a team, so the studio built no starting scene — you stand on the empty template. Lay the foundation in about 12 minutes: look, then plan with contract= and vision= (the contract freezes interfaces, conventions and ranges — a circuit of 2.5–4 km, 6–12 corners — never a layout; the vision says where the world is going), then write each module's stubs as crude playable code, its cameras, demos and probes registered, ${where}, commit, and look at it: a blank world is refused at worker_start. Then start the loop workers. The real content is their owners': the world part designs the world within your ranges and toward the vision.`;
}

/** The starting point the studio built for an empty project, or why it could not — or the foundation the lead lays instead. */
function startingPointLine(startingPoint: AnyRecord | null, leads: boolean): string {
  if (startingPoint?.skipped) return foundationLine(leads);
  if (startingPoint?.ok)
    return `THE STARTING POINT: this game was an empty project, so the studio built the starting point you are standing on (commit ${shortSha(startingPoint.commit ?? "")}${startingPoint.empty ? " — an empty world with working cameras, no content yet" : ""}) and every worker forks from it. There is nothing to compare it with: \`judge against=start\` answers "first build". The whole run is the game itself.`;
  if (startingPoint && leads) return LEAD_BRIEF.startingPointFailed(startingPoint.error);
  if (startingPoint)
    return `THE STARTING POINT: this game is an empty project and the studio's attempt at a starting point failed (${startingPoint.error}). Nothing runs until you make it run: build the world's shape and the shared modules in your worktree with your own hands, look at it, commit — then start workers on it.`;
  return "";
}

/** The plan-review sentence of the rules: a waking lead ends its turn; the long turn's first worker_start waits. */
function planReviewWords(run: Run, loop: DirectorLoop): string {
  if (!run.reviewPlan) return "";
  if (loop === DirectorLoop.Wake) return WAKE_BRIEF.planReview;
  return ' THE USER ASKED TO READ IT FIRST: your first worker_start waits for their word (they may simply say "go"), and builds the plan as it stands if they say nothing.';
}

/** Where the user's words reach the lead: the message that wakes it, or `wait` and run_status in the long turn. */
function userSaysWords(loop: DirectorLoop): string {
  if (loop === DirectorLoop.Wake) return WAKE_BRIEF.userSays;
  return `- The user may speak during the run (USER SAYS in wait and run_status). Their instruction outranks your plan; acknowledge it with a note and act on it.`;
}

/**
 * The rules that never move, with what this run already knows about its kind and its plan review.
 * A lead (`leads`) does the foundations itself in the integration worktree, hands each part to a
 * worker and keeps no memory file: the journal and its digests carry the run.
 */
function rulesThatNeverMove(run: Run, loop: DirectorLoop, leads: boolean): string[] {
  return [
    `RULES THAT NEVER MOVE:`,
    `- Look before you plan: screenshot the game, reach the state the goal is about the way a player does, read the code that owns it. A brief written blind is a run wasted.`,
    `- Then say the plan: \`plan\` — what this run is for and the parts you mean to hand out, in the user's own chat. worker_start refuses until you have called it, so the user can read the plan. Say what kind of game this is in the same call — kind= one of ${KIND_NAMES.join(", ")} — because the harness drives that kind's controls before every judgement and puts only the checks it can pass on the board; a run that declares no kind gets no HUD rule, no look check and no movement check.${run.game?.kind ? ` THIS GAME ALREADY SAYS WHAT IT IS: its studio.json declares a ${run.game.kind} game, and this run is already being judged as one — pass that kind again unless what you saw in this run says otherwise.` : ""}${planReviewWords(run, loop)}`,
    leads
      ? LEAD_BRIEF.delegate
      : `- After the starting point, delegate with plan and worker_start: a worker per area the ask names, the UI and HUD too, on its own files. Handle foundations, integration and small repairs yourself. If capacity or shared ownership blocks delegation, note why and keep improving and playtesting.`,
    // A run from before scope reads its old rules: the rule names a SCOPE its brief has not got.
    scopeLines(run) ? `- ${DIRECTOR_SCOPE_RULE}` : "",
    `- First playable: prioritize a small complete playable loop and integrate its healthy revision before broad atmosphere or asset polish. Continue judging normally; a preview is not acceptance or landing.`,
    `- Asset truth: run_status.assets lists generated originals and current workspace copies. Read it before answering asset questions. Preserve delivered local files; integrate checkpoints them through the host. Never move them to /tmp or swap in remote URLs: assets live in the game folder. State generated-but-unused assets and procedural fallbacks explicitly in completion reports.`,
    `- Completion reporting: distinguish delivered changes from passed, failed and unverified checks. The Studio outcome card counts integrations separately from evaluated attempts; never call all requested features verified merely because the structural board passed.`,
    `- Evidence, not reports: judge, playtest or look at a single session's "done" before you integrate (kept loop rounds were judged); look at the integrated build before you finish.`,
    userSaysWords(loop),
    leads
      ? ""
      : `- Keep .studio/DIRECTOR.md in your worktree current: what you saw, decided, verified and gave up on. Your conversation may be compacted and the run may be paused and resumed; the studio keeps that file for you and writes it back into the next session's worktree, so it is the one memory that survives both. Keep it under ${MAX_DIRECTOR_MEMORY} characters — past that the studio keeps its head and its tail and drops the middle.`,
    `- note the turns of the run as you take them; finish with an honest summary before the deadline.`,
  ];
}

/**
 * When the run is done, as the TIME line says it: a timed build spends its duration; any other
 * finishes once verified and skips optional polish — and a goal commission, whose first finish the
 * art director turns back with its defects (art-direction.ts `shipFinishGate`), hears that those
 * defects are not that polish.
 */
function completionWords(run: Run): string {
  if (durationCommission(run)) return "The selected duration is working time; finish in wrap-up.";
  const words =
    "Finish once required outcomes are verified; time is a ceiling. Report blockers instead of optional polish.";
  return goalCommission(run) ? `${words} ${SHIP_DEFECTS_NOT_POLISH}` : words;
}

/**
 * The brief the director's session opens with: who it is, what the run is about, the tools,
 * the playbook (skills/director.md — SkillOpt trains it), the rules that never move.
 */
export function directorBrief({
  run,
  shape = null,
  ownShape = false,
  capacity = null,
  skill = "",
  softDeadline,
  finalDeadline,
  resume = null,
  integrationWorktree,
  baseCommit,
  nestedRepos = [],
  startingPoint = null,
  startObserved = true,
  gameLessons = [],
  contract = null,
  loop = DirectorLoop.Turn,
  lead = null,
}: DirectorBriefFacts): string {
  const pool = poolWords(capacity);
  const tools = loop === DirectorLoop.Wake ? wakeTools(DIRECTOR_TOOLS) : DIRECTOR_TOOLS;
  const leads = Boolean(lead);
  return joinLines([
    openingLine(run, leads),
    ``,
    `GAME GOAL: ${workingGoal(run)}`,
    scopeLines(run),
    referenceLine(run),
    shapeLine(ownShape, shape),
    requestedStateLine(run.setup),
    ``,
    `TIME: ${minutes(finalDeadline - Date.now())} minutes in all. Your session ends at ${new Date(softDeadline).toISOString().slice(11, 16)} UTC (${minutes(softDeadline - Date.now())} minutes from now); the last ${minutes(finalDeadline - softDeadline)} minutes are reserved for wrapping up. ${completionWords(run)}`,
    whereLine({ gameFolder: lead?.gameFolder ?? null, integrationWorktree, baseCommit }),
    `CAPACITY: ${pool}. ${CAPACITY_RULE}`,
    nestedLine(nestedRepos, leads),
    contractLine(contract, shape, leads),
    unobservedStartLine(startObserved, startingPoint),
    startingPointLine(startingPoint, leads),
    leads
      ? LEAD_BRIEF.baseMustRun
      : `THE BASE MUST RUN: worker_start looks at the commit a worker forks from before it starts anyone, whatever it forked from (a console error there costs every worker its first iteration); a refusal names the problems — fix them in your worktree, commit, and start again. An integration head that fails its health pass cannot land: fix it, or judge it (a passing judge counts).`,
    ``,
    // What earlier runs on this exact game already paid for (loop/ledger.ts). The studio keeps
    // its own ledger of outcomes per game; these are the patterns it found in them.
    lastTimeBlock(gameLessons),
    // Three lines, not five (M4.8b). Every tool below arrives with its own description and
    // parameters through the engine's tool channel; a second, hand-maintained prose copy of the
    // same thirteen schemas cost the director 3.6 KB of its window every turn and said half of
    // it in fragments truncated at forty characters. What a compacted session must keep is the
    // vocabulary — the NAMES — and the grammar for spelling one, so that is what stays.
    `YOUR TOOLS — ${toolSyntax(run.engine)}:`,
    `- Your window shows one build at a time: look points it (target=integration|live|<worker id>), computer is your hands and eyes on it, capture takes every registered camera of it at once. Start every look with a screenshot.`,
    `- The run's own tools: ${tools.map((t) => t.name).join(", ")}.`,
    ``,
    skill ? `THE PLAYBOOK:\n${skill.trim()}` : "",
    ...rulesThatNeverMove(run, loop, leads),
    resume ? `\nYOU WERE RESUMED. ${resume}` : "",
  ]);
}

/** Who the session is: a director with its own hands, or the chat's own session leading the build (one session). */
function openingLine(run: Run, leads: boolean): string {
  if (leads) return LEAD_BRIEF.opening(run.runId, run.project ?? "");
  return `You are the DIRECTOR of run ${run.runId} on the game "${run.project}". You run this build from start to finish: you look at the game, decide what it needs, do it yourself or hand it to workers, verify with your own eyes, integrate, show the user, and finish. Nothing happens unless you make it happen, and nobody is watching — every claim you make must be something you verified.`;
}

/** Where the session is: the integration worktree it edits in, or the game folder a lead reads from. */
function whereLine({
  gameFolder,
  integrationWorktree,
  baseCommit,
}: {
  gameFolder: string | null;
  integrationWorktree: string;
  baseCommit: string | null;
}): string {
  if (gameFolder) return LEAD_BRIEF.whereYouAre({ gameFolder, integrationWorktree, baseCommit });
  return `WHERE YOU ARE: your cwd is the run's integration worktree (${integrationWorktree}), a git worktree of the game at commit ${shortSha(baseCommit ?? "")} — the integration branch. Edit here yourself for what is quicker to do than to delegate; commit what workers should fork from. The live game folder the user sees stays untouched until finish lands this branch. Never git push, never edit outside this worktree. Workers get worktrees of their own; the studio commits for them.`;
}

/**
 * Which world this run is in is a question the worktree answers, not the brief: with the
 * user's consent the studio versions a nested repository inside every fork of the game
 * (M2.5), and a lead told otherwise hand-ports code it already has under version control.
 */
function nestedLine(nestedRepos: readonly string[], leads: boolean): string {
  if (!nestedRepos.length) return "";
  if (leads) return LEAD_BRIEF.nested(nestedRepos);
  return `NESTED REPOSITORIES: ${nestedRepos.join(", ")} — each is a git repository of its own inside the game folder. Run \`git ls-files -- <path>\` in your worktree: if it lists files, the studio has versioned that folder here and your workers' edits inside it are committed, integrated and landed like any other. If it lists nothing, nothing inside it is versioned — vendor what the run builds on first (copy the sources, without their .git, into src/) and commit that.`;
}

/** What the last health pass said about the integration branch, as the wrap-up quotes it. */
function lastHealthWords(integrationHealthy: boolean | null): string {
  if (integrationHealthy === true) return " (last health pass: loads)";
  if (integrationHealthy === false) return " (last health pass: problems — land=no unless you fixed them)";
  return "";
}

/** The wrap-up session's prompt: minutes left, finish now. */
export function wrapUpPrompt({
  run,
  finalDeadline,
  integrationHead,
  integrationHealthy,
  workers,
  fromScratch = false,
}: {
  run: Run;
  finalDeadline: number;
  integrationHead: string | null;
  integrationHealthy: boolean | null;
  workers: Worker[];
  fromScratch?: boolean;
}): string {
  const running = workers.filter((w) => isRunning(w)).map((w) => w.id);
  const head = integrationHead ? shortSha(integrationHead) : "none";
  return [
    `Run ${run.runId}: your session reached its deadline; ${minutes(finalDeadline - Date.now())} minutes remain. Do not start workers or long looks.`,
    running.length
      ? `Workers still running: ${running.join(", ")} — finish stops them; integrate what is worth keeping first (integrate is quick).`
      : "",
    `Integration branch: ${head}${lastHealthWords(integrationHealthy)}.`,
    `Call finish now with land=yes if the integrated build loads and ${fromScratch ? "does what the goal asked (this run started from an empty project — the user had no game at all, so anything that runs and plays is this run's build)" : "is better than what the user had"}, otherwise land=no, and an honest summary. Then stop.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The seam, in the two worlds a worker builds in (M4.6): the template's entry carries a wiring
 * block anyone may add a line to; a game the user brought has no such thing, and its entry
 * belongs whole to whoever owns it.
 */
function seamLine(worker: Worker, ownShape: boolean, shape: AnyRecord | null): string {
  if (ownShape) return ownSeamLine(worker, shape);
  if (worker.owns.length)
    return `YOUR FILES: ${worker.owns.join(", ")}${worker.ownsMain ? ` and the entry module` : ` — touch the entry module only in its FACET WIRING block`}.`;
  if (worker.ownsMain) return "";
  return "Touch the entry module only in its FACET WIRING block.";
}

/** The seam of a worker in a game the user brought: its files, and whether the entry is its too. */
function ownSeamLine(worker: Worker, shape: AnyRecord | null): string {
  if (worker.owns.length)
    return `YOUR SEAM: ${worker.owns.join(", ")}${worker.ownsMain ? `, plus ${shape?.main ?? "the entry module"} and the studio contract` : `. ${shape?.main ?? "The entry module"}, the studio contract and index.html are not yours — if your work needs a change in one of them, say so in your report and leave it`}.`;
  if (worker.ownsMain) return "";
  return `${shape?.main ?? "The entry module"}, the studio contract and index.html are not yours — if your work needs a change in one of them, say so in your report and leave it.`;
}

/** The brief a single-session worker gets around the director's own words. */
export function singleWorkerBrief({
  run,
  worker,
  shape = null,
  ownShape = false,
  setup = null,
}: {
  run: Run;
  worker: Worker;
  shape?: AnyRecord | null;
  ownShape?: boolean;
  setup?: AnyRecord | null;
}): string {
  return joinLines([
    `You are a BUILDER for run ${run.runId} on the game "${run.project}", working in an isolated copy of the game (this folder). The run's director wrote your brief; build exactly that, then stop.`,
    ``,
    `GAME GOAL (context): ${workingGoal(run)}`,
    scopeLines(run),
    visionBriefLines(run),
    ``,
    `YOUR BRIEF FROM THE DIRECTOR — ${worker.title}:`,
    worker.brief,
    ``,
    seamLine(worker, ownShape, shape),
    ownShape
      ? `THIS GAME HAS ITS OWN SHAPE: entry ${shape?.main ?? "src/main.ts"}${shape?.build ? `, built with \`${shape.build}\` — run it before you finish and fix what it reports` : ""}; keep its entry, UI and input handling; keep the studio contract wired. This game is the user's own code: follow the conventions it already has, and do not rename, restyle or reformat anything you did not have to change.`
      : "",
    setup
      ? `THE REQUESTED STATE: your window opens on the state this work is about (${setup.note ?? "the run's setup"}); if a screenshot says the state was not reached, fix the way a player reaches it, not what the game boots into.`
      : "",
    `YOU HAVE HANDS AND EYES: ${toolCall(roleEngine(run, RoleKey.Builder), "computer")} runs this folder's build live in its own window (its own description lists every action), and ${toolCall(roleEngine(run, RoleKey.Builder), "capture")} takes every registered camera at once. Look at what you made before you say it is done; the director will.`,
    `Do not commit — the studio commits your folder when you stop. Do not touch files outside this folder. Keep ${facetNotes(worker.id)} with what you did and what you verified.`,
    `When you are done, reply with a short report: what you built, what you verified by looking, what you could not do.`,
  ]);
}

/** What a resumed session is told about the run it picks up. */
export interface ResumeFacts {
  runId: string;
  forkCommit: string | null;
  baseCommit: string | null;
  /** Commits the branch carries beyond the run's starting point. */
  aheadOfBase: number;
  /** The last session's own record (`journal.director`). */
  priorDirector: AnyRecord;
  /** Did last session's `.studio/DIRECTOR.md` come back into this worktree? */
  memoryRestored: boolean;
  /** A lead that is its chat's own session keeps no memory file: the journal carries the run. */
  leads?: boolean;
}

/** The resumed session's note: where the branch stands, what became of the workers, the plan and the memory. */
export function resumeNote({
  runId,
  forkCommit,
  baseCommit,
  aheadOfBase,
  priorDirector,
  memoryRestored,
  leads = false,
}: ResumeFacts): string {
  const commits = `commit${aheadOfBase === 1 ? "" : "s"}`;
  const ahead = aheadOfBase
    ? ` — ${aheadOfBase} ${commits} beyond the starting point ${shortSha(baseCommit)}, which \`finish land=yes\` lands as they are`
    : "";
  const before = Object.keys(priorDirector.workers ?? {}).join(", ") || "none";
  const plan = priorDirector.plan
    ? "Last session's plan is still this run's plan (run_status carries it); call plan again if what is left is a different one."
    : "This run has no plan the user can read yet: call plan before your first worker.";
  const memory = memoryWords(memoryRestored, leads);
  return `The integration branch stands at ${shortSha(forkCommit ?? "")}${ahead}; workers from before (${before}) are gone — their commits are kept on ${runRef(runId, "workers", "<id>")}, and integrated ones are on the branch. ${plan} ${memory}`;
}

/** What a resumed session is told about its memory: its file, the lack of one, or — for a lead — the journal. */
function memoryWords(memoryRestored: boolean, leads: boolean): string {
  if (leads) return LEAD_RESUMED_MEMORY;
  if (memoryRestored)
    return "Read .studio/DIRECTOR.md — the notes you kept last session, restored into this worktree — then continue.";
  return "You kept no .studio/DIRECTOR.md last session: run_status and the notes above are all the memory this one has. Start one now.";
}

/** What the base session is told about its clock: boot a small visible scene and hand back, not the whole goal. */
export function preparationBudgetNote(budgetMinutes: number): string {
  return `PREPARATION BUDGET: ${budgetMinutes} minutes. Only make the entry boot with a renderer, camera and a small visible starting scene; reuse the existing template. Do not implement the entire goal, research the instrumentation or design a framework. Inspect it once, fix startup errors, and return so the lead has time to build the requested scene.`;
}

/** What the director's session is told after an engine limit it was made to wait out. */
export function limitResumePrompt(waitedMinutes: number): string {
  return `The engine's limit paused you for ${waitedMinutes} minutes; your workers kept running. Call run_status, then continue where you were.`;
}

/** What the director's session is told when its turn ended with working time left in a timed build. */
export function continuationPrompt(minutesLeft: number): string {
  return `The timed build still has ${minutesLeft} working minutes. Your previous turn ended, but the build is still running. Call run_status and read pending user instructions. Plan and start a worker for the most valuable unfinished in-scope feature or a deeper layer of one, or a verification gap; inspect, integrate and show progress. Continue improving within the original goal. Do not finish or wait out the clock.`;
}
