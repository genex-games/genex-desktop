/**
 * Seed upgrades — closing the trap that bit twice on day one.
 *
 * The harness workspace is the agent's own editable copy of the seed, created on first launch.
 * Naively it was seeded only when missing, so a fix shipped in the app's `src/harness-seed`
 * never reached an existing install — twice in one evening someone had to quit the app and
 * delete the workspace by hand to pick up a one-line guard fix.
 *
 * The upgrade rule respects full recursion (hard constraint #1 — the agent owns its source):
 * a **manifest** outside the workspace records the hash of the seed content last applied to
 * each file. On boot, for every file in the new seed:
 *
 *  - not in the manifest              → new seed file  → copy in            ("added")
 *  - workspace hash == manifest hash  → agent untouched → apply the new seed ("updated")
 *  - workspace hash != manifest hash  → agent edited it → LEAVE IT           ("kept")
 *  - in the manifest but deleted      → agent deleted it → leave it deleted  ("kept")
 *
 * There is a fifth outcome, for a path the seed used to ship and no longer does: when the
 * workspace copy still hashes to what the manifest last applied, it is backed up and removed
 * ("retired"). See RETIRED_SEED_PATHS.
 *
 * Files the agent created itself (memory, self-installed tools) are never touched. Replaced
 * files are backed up first, so even a wrong call here is recoverable without git archaeology.
 *
 * Installs from before this file exist have no manifest. They also predate the first
 * self-edit (the manifest ships before the first unattended run), so the one-time migration
 * treats the whole workspace as untouched: the new seed is applied file by file and the
 * manifest written. From then on every install has one.
 */
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson, pathExists, readJsonIfExists, readRegularFile, writeFileNoFollow } from "./fsx.ts";
import { containedReal, isBelow } from "./paths.ts";
import { RENAMED_SEED_FILES, renameInSource } from "./seed-renames.ts";

/** What a boot's seed pass did: first launch, something changed, or nothing to do. Read by the boot notice. */
export const SeedUpgradeMode = {
  Seeded: "seeded",
  Upgraded: "upgraded",
  Unchanged: "unchanged",
} as const;
export type SeedUpgradeMode = (typeof SeedUpgradeMode)[keyof typeof SeedUpgradeMode];

/** Where an upgrade backs up the seed content it replaces (a vintage), under the updates folder. */
const SEED_BACKUP_PREFIX = "seed-backup-";
/** Where the layout migration backs up the agent's edited modules, beside the vintages but not one of them. */
const HARNESS_EDITS_PREFIX = "harness-edits-";
/** The largest module the rename rewrites; anything bigger is no seed module and is left alone. */
const MAX_RENAMED_MODULE_BYTES = 4_000_000;
/** How much of a failed layout migration's error the manifest keeps. */
const LAYOUT_ERROR_MAX_CHARS = 500;
/** The format `writeCatalogue` writes. */
const CATALOGUE_VERSION = 2;

export interface SeedUpgradeReport {
  /** "seeded" = first launch; "upgraded" = something changed; "unchanged" = nothing to do. */
  mode: SeedUpgradeMode;
  added: string[];
  updated: string[];
  /** Agent-edited (or agent-deleted) files the new seed wanted to change but must not. */
  kept: string[];
  /** Seed files this build no longer ships, removed from the workspace because nothing had edited them. */
  retired: string[];
  /**
   * The agent's files whose old seed names were rewritten to the renamed ones (seed-renames.ts),
   * at their path after the upgrade: an edited copy of a renamed module is listed at its new path.
   */
  renamed?: string[];
  /**
   * Code the seed moved out of a file the agent edited (kept), which the kept copy still defines
   * while other harness files now import it from its new home. See SEED_MOVES.
   */
  moved: SeedMoveNotice[];
  /**
   * Kept files that still call the host the way an older seed did, which the host now refuses
   * (SEED_CALL_CHANGES): the agent must carry the new call shape into its copy.
   */
  outdatedCalls?: string[];
  /**
   * Seed `.ts` files held back because the workspace still has the JavaScript layout they replace
   * (`x.mjs`): laid down by `migrateHarnessLayout` once a fork proves the migrated self boots.
   */
  deferred?: string[];
  /**
   * The manifest was last written by an older build of the app, one from before the TypeScript
   * layout (it keeps no `writer`), over a workspace this build had already moved or begun to move.
   * Said once: this upgrade stamps the manifest again.
   */
  downgraded?: true;
}

/** Names the seed moved from one file to another; the old file re-exports them from the new one. */
export interface SeedMove {
  from: string;
  to: string;
  names: readonly string[];
}

/** A move that splits a kept file from its callers: what the kept copy still defines, and who calls the new home. */
export interface SeedMoveNotice {
  from: string;
  to: string;
  /** The moved names the agent's kept copy still defines itself. */
  names: string[];
  /** Workspace files that import one of those names from `to`, and so no longer run the kept copy. */
  callers: string[];
}

/**
 * Code the seed moved between files (the harness structure change, 2E-pre). The old file keeps
 * exporting every moved name, re-exported from the new home, so a kept file of either vintage
 * still loads. What cannot be kept is the reach of an edit: when the agent edited, say,
 * `gatherEvidence` in its own gauntlet.ts, the upgrade keeps that file — but the untouched
 * callers are updated and now import the evidence pass from evidence.ts, so the agent's fix runs
 * only inside the gauntlet itself. Holding the callers back instead would freeze every shipped
 * fix to the director, the facet loop and autopilot for as long as the gauntlet stays edited;
 * `applySeed` reports the split (`moved`) so the agent can carry its edit to the new home.
 */
export const SEED_MOVES: readonly SeedMove[] = [
  {
    from: "loop/gauntlet.ts",
    to: "loop/evidence.ts",
    names: [
      "gatherEvidence",
      "withObservationPatience",
      "observationOnlyFailure",
      "classifyEvidenceFailure",
      "applySetup",
      "proveStep",
      "consoleProblems",
      "EMPTY_SCENE_PROBE",
      "MISSING_CONTRACT",
      "STEP_WITNESS",
    ],
  },
  { from: "loop/gauntlet.ts", to: "loop/git.ts", names: ["unversionedNested"] },
  { from: "loop/autopilot.ts", to: "loop/prompts-build.ts", names: ["baseBrief", "contractWiringAsk"] },
  { from: "loop/autopilot.ts", to: "loop/config.ts", names: ["PLAN_REVIEW_WAIT_MS"] },
  {
    from: "loop/director/rules.ts",
    to: "loop/director/args.ts",
    names: ["slug", "list", "num", "yes", "withoutFrames", "parseJson", "namedTitle"],
  },
  {
    from: "loop/director/rules.ts",
    to: "loop/director/budgets.ts",
    names: [
      "SEED",
      "CLOSE_SETTLE_MS",
      "WORKER_FLOOR_MS",
      "MAX_WAIT_S",
      "MAX_WORKERS",
      "MIN_FREE_MB",
      "wrapReserveMs",
      "timedWorkRemaining",
      "preparationBudgetMs",
      "workerWindows",
      "shortBudgetWarning",
      "MONITOR_TICK_MS",
      "planReviewWaitMs",
      "monitorEveryMs",
      "medianMinutes",
    ],
  },
  {
    from: "loop/director/rules.ts",
    to: "loop/director/memory.ts",
    names: ["MAX_DIRECTOR_MEMORY", "clampDirectorMemory", "directorMemoryKeep"],
  },
  {
    from: "loop/director/rules.ts",
    to: "loop/director/tool-specs.ts",
    names: ["DIRECTOR_TOOLS", "directors", "directorTool", "headSynced"],
  },
  {
    from: "loop/director/rules.ts",
    to: "loop/director/digests.ts",
    names: ["iterationDigest", "clampBoard", "loopDigest", "loopNote", "workerDigest", "waitDigest"],
  },
  {
    from: "loop/director/rules.ts",
    to: "loop/director/briefs.ts",
    names: ["contractBrief", "directorBrief", "wrapUpPrompt", "singleWorkerBrief"],
  },
  { from: "loop/director/rules.ts", to: "loop/time.ts", names: ["minutes"] },
  // Goal-directed generation first added these to budgets.ts, which a director kept from before
  // them cannot export; the loop imports them from a module of their own.
  {
    from: "loop/director/budgets.ts",
    to: "loop/director/commission.ts",
    names: ["durationCommission", "goalCommission"],
  },
  { from: "loop/main.ts", to: "loop/run-dispatch.ts", names: ["loopRunRefusal"] },
  { from: "loop/main.ts", to: "loop/chat-dispatch.ts", names: ["judgeableFirst"] },
  { from: "loop/turn-loop.ts", to: "loop/chat-session.ts", names: ["nameFromAsk"] },
  { from: "loop/turn-loop.ts", to: "loop/tool-loop.ts", names: ["resolveContextWindow"] },
  {
    from: "loop/facet-loop.ts",
    to: "loop/facet/rules.ts",
    names: [
      "ITERATION_HEADROOM",
      "pinFixRecipe",
      "facetIsDone",
      "tooLateToStart",
      "stopSignal",
      "stopsThisRound",
      "lessonsFromNotes",
      "strongFlips",
      "acceptRound",
      "movesThisRound",
      "chooseMove",
      "moveVerdict",
      "grownCheckIds",
      "judgeChecksToRetire",
    ],
  },
  {
    from: "loop/facet-loop.ts",
    to: "loop/facet/policy.ts",
    names: ["FACET_POLICY", "FACET_POLICY_RANGE", "normalizeFacetPolicy", "loopStateOf"],
  },
  {
    from: "loop/facet-loop.ts",
    to: "loop/facet/prompt.ts",
    names: [
      "MAX_PROMPT_LIST",
      "MAX_PROMPT_STEERING",
      "MAX_PROMPT_FAILURE",
      "briefWithMovedSections",
      "steerPrompt",
      "promptImagesFor",
      "facetPrompt",
    ],
  },
  {
    from: "loop/facet-loop.ts",
    to: "loop/facet/defects.ts",
    names: ["similarDefect", "sameDefectOpening", "suggestedProbe", "facetVocabularyScore", "defectsToChecks"],
  },
  { from: "loop/gauntlet.ts", to: "loop/gauntlet-prompts.ts", names: ["buildBrief"] },
  { from: "loop/kinds.ts", to: "loop/config.ts", names: ["MAX_PLAY_SCRIPT"] },
  // The Unreal Loop's step machine gave way to one lead (loop/unreal/lead.ts).
  { from: "loop/unreal/live-journal.ts", to: "loop/unreal/lead-journal.ts", names: ["unrealTool"] },
  // The runner's plugin steps moved to a module of their own, which an older kept journal can't lack.
  { from: "loop/unreal/lead-journal.ts", to: "loop/unreal/lead-steps.ts", names: ["unrealTool"] },
];

/** A host call whose shape the seed changed: a kept copy of `file` without `marker` calls the older way. */
export interface SeedCallChange {
  file: string;
  /** Text every copy that calls the new way holds. */
  marker: string;
}

/**
 * Host calls the seed changed with the host. The host runs a plugin tool kept for the harness only
 * when `plugins.invoke` says `step: true` (`checkpoint: true` for a write Plan mode holds back), so
 * a kept copy of these files from before that change has every harness step refused as an unknown
 * tool. `plugins.tools` names the game (`project`), whose facts pick its plugin tools: a kept copy
 * that names none is offered a web game's tools whatever the game holds. `applySeed` reports such a
 * copy (`outdatedCalls`, each file once) and the boot notes it for the agent. The Unreal lead's
 * runner calls from `loop/unreal/lead-steps.ts`, new with the step change, so no kept copy of it is
 * older (a kept `lead-journal.ts` that still defines its own call is a move). `game.scaffold` with
 * no `kind` now makes an empty folder with no kind: a kept Loop launch or runner that names no kind
 * makes its new game empty, a kept run start leaves a game with no kind unstarted before its web
 * Loop, and a kept `tools/game-tools.ts` has no `start_web_game` for a local model. A kept
 * `loop/prompt.ts` that never reads `prompts/operating-rules-web.md` gives a web game's local turn
 * no web rules, so it is reported the same way; so are a kept `prompts/operating-rules.md` that
 * still gives every turn the web rules, and a kept `loop/chat-session.ts` that briefs a new game
 * (now empty) as the web starter and never names `start_web_game`. A kept `loop/main.ts` that never
 * claims `workers`, a kept `loop/delegated-turn.ts` that opens no worker pool for a chat turn, and a
 * kept `loop/chat-session.ts` whose brief never says the session runs workers leave the chat's own
 * session without its workers (or unaware of them), so they are reported too. The director joined
 * the same model: a kept tool list or handler without `WorkerTool.` has no `worker_mark` and no
 * readers, a kept wake prompt or brief still names the old `wait`, kept builders delegate with no
 * `worker` grant (they stay unattended and boxed: safe, but not in the chat's mode), a kept wake loop
 * still names a rejected worker, and a kept close leaves the run's readers to end on their own.
 * A kept `tools/game-tools.ts` whose `game.start` names no chat writes the web starter even while
 * that chat is in Plan mode; kept briefs, builders and base sessions of a director's run that never
 * open with Genex's identity leave its workers unaware they work inside Genex, on which folder.
 * A kept director handler that never reads its builders' questions leaves the lead blind to a
 * builder waiting on the person, a kept build turn treats a full chat as a broken build, and a kept
 * tool list offers its readers no research. A kept wake loop that never reads the run's job ends
 * leaves a resting lead asleep through them; kept wake rules lack their kind (such an end still
 * wakes the lead soon, as news); and a kept `loop-run.ts` or journal that keeps no job cursor reads the
 * run's ends again after a restart. Kept builders or chat turns that write no worker records leave
 * those workers off Builds and the chat; a kept run start without `workerRecords` draws its Loop as a
 * tree only from its first worker; a kept tool list never tells the lead the person reads its note.
 * A kept chat turn from before Genex's moments never takes Genex's checkpoint at its end and never
 * announces its turn to the game's plugins; kept director parts never announce the run's start, end,
 * turns, finish or builders, and a kept run start never reads the moments the game's plugins hook.
 * A kept host-method table without the moments' and locks' methods turns them all off.
 */
export const SEED_CALL_CHANGES: readonly SeedCallChange[] = [
  // A chat turn's own end save is Genex's checkpoint now (`checkpoint.take`), and its moments are
  // announced only when the game's plugins hook them (`hooksOn`): it calls no plugin tool by name.
  { file: "loop/delegated-turn.ts", marker: "endOfTurnCheckpoint(" },
  { file: "loop/delegated-turn.ts", marker: "hooksOn(" },
  { file: "loop/delegated-turn.ts", marker: "HostMethod.PluginsTools, { project }" },
  { file: "tools/index.ts", marker: "HostMethod.PluginsTools, { project" },
  { file: "loop/chat-dispatch.ts", marker: "kind: ProjectStarter.Web" },
  { file: "loop/run-dispatch.ts", marker: "startWebIfPending(" },
  { file: "loop/autopilot.ts", marker: "kind: ProjectStarter.Web" },
  { file: "loop/director/setup.ts", marker: "kind: ProjectStarter.Web" },
  { file: "loop/gauntlet.ts", marker: "kind: ProjectStarter.Web" },
  { file: "tools/game-tools.ts", marker: "HostMethod.GameStart" },
  // Not host calls: the web rules moved to their own file, which a kept local prompt never reads
  // and kept rules still repeat for every turn; and a kept brief tells an empty new game nothing of
  // its first step.
  { file: "loop/prompt.ts", marker: '"prompts/operating-rules-web.md"' },
  { file: "prompts/operating-rules.md", marker: "run it and look at it running" },
  { file: "loop/chat-session.ts", marker: "pendingKindRule(" },
  { file: "loop/main.ts", marker: '"workers"' },
  { file: "loop/delegated-turn.ts", marker: "withChatWorkers(" },
  { file: "loop/delegated-turn.ts", marker: "chatWorkersGrant(" },
  { file: "loop/chat-session.ts", marker: "WORKERS_BRIEF_LINE" },
  { file: "loop/director/tool-specs.ts", marker: "WorkerTool." },
  { file: "loop/director/tools.ts", marker: "WorkerTool." },
  { file: "loop/director/wake-prompts.ts", marker: "worker_wait" },
  { file: "loop/director/briefs.ts", marker: "worker_wait" },
  { file: "loop/director/workers.ts", marker: "workerGrant(" },
  { file: "loop/facet/phases/build.ts", marker: "worker: loop.options.worker" },
  { file: "loop/director/wake.ts", marker: "rejectedNews(" },
  { file: "loop/director/integrate.ts", marker: "closeReaders(" },
  // A local model's start_web_game names its chat, so the host holds it while that chat plans; and
  // every worker of a director's run is told first that it works inside Genex, on which folder.
  { file: "tools/game-tools.ts", marker: "threadId: ctx.threadId" },
  { file: "loop/director/briefs.ts", marker: "builderIdentity(" },
  { file: "loop/director/workers.ts", marker: "runIdentity(" },
  { file: "loop/director/setup.ts", marker: "runIdentity(" },
  { file: "loop/facet/phases/brief.ts", marker: "withIdentity(" },
  // A run's own workers that wait on the person are their lead's news, a full chat is a wait for
  // room, and a director's reader may research the web.
  { file: "loop/director/tools.ts", marker: "waitingBuilders(" },
  { file: "loop/facet/phases/build.ts", marker: "withWorkerRoom(" },
  { file: "loop/director/tool-specs.ts", marker: "research: {" },
  // A director's single worker refused for room waits for room, as its builders do.
  { file: "loop/director/workers.ts", marker: "withWorkerRoom(" },
  // A job of the run that ends wakes a resting lead: the wake loop reads the ends (`jobs.list`),
  // its rules name the kind, and the run's journal keeps where it read to.
  { file: "loop/director/wake.ts", marker: "watchJobs(" },
  { file: "loop/director/wake-schedule.ts", marker: "JobEnded" },
  { file: "loop/director/loop-run.ts", marker: "jobsCursor" },
  { file: "loop/director/journal.ts", marker: "jobsCursor" },
  // Every worker leaves its start and end on the chat's log for the Builds graph and the chat: the
  // director's builders, and a chat turn's workers with the person's request.
  { file: "loop/director/workers.ts", marker: "recordBuilderStarted(" },
  { file: "loop/delegated-turn.ts", marker: "ask: options.text" },
  // A director's run says from its start that its workers leave records (its graph is a tree from
  // the start), and the lead is told the person reads its note on a worker.
  { file: "loop/director/setup.ts", marker: "workerRecords: true" },
  { file: "loop/director/tool-specs.ts", marker: "Why, for the person" },
  // A director's run announces Genex's moments to the game's plugins: its start and end, each of
  // the lead's turns, its finish and each builder's start and end, read from the game it set up.
  { file: "loop/director.ts", marker: "HookEvent.RunPrepare" },
  { file: "loop/director/setup.ts", marker: "hookEvents: game?.hookEvents" },
  { file: "loop/director/wake.ts", marker: "HookEvent.TurnStart" },
  { file: "loop/director/tools.ts", marker: "HookEvent.Finish" },
  { file: "loop/director/workers.ts", marker: "workerStartHooks(" },
  // The generated host-method table names the moments' and locks' methods: without them every
  // moment answers empty, every save point is refused and an in-place worker holds no lock.
  { file: "loop/host-methods.ts", marker: 'LocksHold: "locks.hold"' },
  { file: "loop/host-methods.ts", marker: 'LocksRelease: "locks.release"' },
  { file: "loop/host-methods.ts", marker: 'CheckpointTake: "checkpoint.take"' },
  { file: "loop/host-methods.ts", marker: 'HooksFire: "hooks.fire"' },
];

interface SeedManifest {
  /** rel path → sha256 of the seed content last applied there. */
  files: Record<string, string>;
  /** rel path → when a retirement removed it: the paths in RETIRED_SEED_PATHS, and the `.mjs` files the layout migration removed. */
  retired?: Record<string, string>;
  /** The workspace layout the manifest describes (LAYOUT_VERSION); absent means 1, JavaScript. */
  layoutVersion?: number;
  /** The last layout migration that failed its fork boot, so the next boot does not repeat it unchanged. */
  layoutAttempt?: { key: string; at: string; error: string };
  /**
   * The build that last wrote the manifest: its layout, and its app version when the caller knew
   * it. Every write by this build stamps it; a build from before the TypeScript layout rewrites the
   * manifest without it, which is how a return from such a build is noticed (`downgraded`).
   */
  writer?: { layout: number; app?: string };
}

/** The manifest's bookkeeping besides the file hashes, carried through every rewrite of it. */
type ManifestExtras = Omit<SeedManifest, "files">;

/**
 * The harness workspace's layout. 1: JavaScript, `loop/*.mjs` (before the harness was TypeScript).
 * 2: TypeScript, `loop/*.ts`. A workspace moves from 1 to 2 once, through `migrateHarnessLayout`.
 */
export const LAYOUT_VERSION = 2;

/** The folders whose modules changed extension from `.mjs` to `.ts` with layout 2. */
const CODE_DIRS = ["loop/", "tools/", "memory/"];

/** A manifest entry no file hashes to: the file at that path is the agent's. */
const AGENT_WROTE = "agent-wrote-this-file";

const isLegacyModule = (rel: string): boolean => rel.endsWith(".mjs") && CODE_DIRS.some((dir) => rel.startsWith(dir));
/** A module of the TypeScript layout, which may have a `.mjs` predecessor. */
const isTsModule = (rel: string): boolean =>
  rel.endsWith(".ts") && !rel.endsWith(".d.ts") && CODE_DIRS.some((dir) => rel.startsWith(dir));
/** A file only the TypeScript layout has: its modules, its types and its compiler config. */
const isTsLayoutFile = (rel: string): boolean =>
  isTsModule(rel) || (rel.startsWith("types/") && rel.endsWith(".d.ts")) || rel === "tsconfig.json";
const tsFor = (rel: string): string => rel.replace(/\.mjs$/, ".ts");
const mjsFor = (rel: string): string => rel.replace(/\.ts$/, ".mjs");

/**
 * Agent-edited JavaScript modules that cannot run in the TypeScript layout whatever the edit was:
 * the JavaScript tool registry imports only `tools/*.mjs`, so renamed into place it would register
 * none of the shipped tools — `write_own_file` among them, leaving the agent nothing to repair it
 * with — while the self still boots and answers its healthcheck (neither builds the registry).
 * The shipped `.ts` replaces it and the edit is backed up ("replaced").
 */
const INCOMPATIBLE_WHEN_EDITED: ReadonlySet<string> = new Set(["tools/index.mjs"]);

async function readManifest(file: string): Promise<SeedManifest | null> {
  const body = await readJsonIfExists<SeedManifest>(file);
  return body && typeof body === "object" && body.files && typeof body.files === "object" ? body : null;
}

function extrasOf(manifest: SeedManifest | null): ManifestExtras {
  if (!manifest) return {};
  const { files: _files, ...extras } = manifest;
  return extras;
}

/**
 * Seed `.ts` modules whose JavaScript predecessor the workspace still carries or the manifest still
 * owns: applySeed leaves them to the layout migration. Laying `loop/main.ts` down beside an
 * agent-edited `loop/main.mjs` would make the bootstrap run the new file and silently drop the
 * agent's edit; the migration renames that edit into place instead.
 */
async function deferredByLayout(
  seedTs: readonly string[],
  workspaceDir: string,
  manifest: SeedManifest | null,
): Promise<Set<string>> {
  const deferred = new Set<string>();
  const layout = manifest?.layoutVersion ?? 1;
  for (const rel of seedTs) {
    const legacy = mjsFor(rel);
    if (await pathExists(path.join(workspaceDir, legacy))) deferred.add(rel);
    // Deleted by the agent before the migration: the migration carries the deletion over. (A
    // `.ts` already on disk — the reseed laid the shipped self down — is nothing to carry.)
    else if (layout < LAYOUT_VERSION && (await deletedBeforeMigration(workspaceDir, manifest, rel, legacy)))
      deferred.add(rel);
  }
  return deferred;
}

/** The manifest owns the legacy `.mjs` of `rel` but not `rel`, and no `rel` is on disk. */
async function deletedBeforeMigration(
  workspaceDir: string,
  manifest: SeedManifest | null,
  rel: string,
  legacy: string,
): Promise<boolean> {
  const ownedLegacyOnly = manifest?.files[legacy] !== undefined && manifest.files[rel] === undefined;
  if (!ownedLegacyOnly) return false;
  return !(await pathExists(path.join(workspaceDir, rel)));
}

/**
 * Seed files the app used to ship and no longer does, which a workspace should stop carrying.
 *
 * `applySeed` walks the seed directory, so a file the seed drops is simply never visited again:
 * every install that ever booted the older build keeps its copy for ever, in the prompt index,
 * in the skill list, in the architect's file menu. These four skills were read by no run code
 * (only `director.md` and `facet-decomposition.md` are) and said things about a loop that no
 * longer exists. The workers' handover modules went when Claude Code and Codex workers were left
 * to their own compaction: nothing imports them, and a copy left behind would fail
 * the self-edit gate's type check over `loop/` (it reads facet state that no longer exists).
 *
 * The rule is the ownership rule, backwards: a workspace copy whose bytes still equal what the
 * manifest last applied was written by the app and may go; anything else is the agent's and is
 * kept for ever. On a pre-manifest install there is nothing to compare against and the one-time
 * migration already reads the whole workspace as the app's, so the copy goes on that pass — the
 * only pass that could: the seed no longer ships these paths, so they never acquire a manifest
 * entry of their own, and a later boot would find nothing to act on. The copy is backed up
 * first, which is why the pass refuses to run at all when no `backupDir` was passed (the
 * crash-recovery reseed path).
 *
 * The Unreal Loop's part plan and part prompts went with the part runner, and the step machine that
 * replaced it (its planner, keep rule, board, probes, checkpoint, helpers, prompts, tools, graph,
 * the part runner's shim) went when one lead took over (`loop/unreal/lead.ts`); an untouched copy
 * left behind would no longer type-check against the seed (`cpp.ts`, `live-contract.ts`). Two of
 * its files stay as shims, because files the agent may have kept import from them:
 * `loop/unreal/live.ts` (a kept `run-dispatch.ts`'s `runUnrealLive`, the lead now) and
 * `loop/unreal/live-journal.ts` (a kept `restore.ts`'s `unrealTool`, in `SEED_MOVES`). So do the
 * lead's own reading of whether Unreal is there (`editor-life.ts`) and a chat's own waits and reads
 * of Unreal (`editor-wait.ts`, `editor-wait-prompts.ts`, `editor-activity.ts`): no current module
 * calls them since Genex's `health`, checkpoint and kinds' readiness took them over, but kept copies
 * of `delegated-turn.ts`, `unreal-prompts.ts`, `lead-turn.ts`, `restore.ts` and `save-point.ts`
 * still import them, so they stay until the Unreal runner's last by-name calls go.
 *
 * The JavaScript modules the TypeScript seed replaced (`loop/*.mjs` → `loop/*.ts`) are not listed
 * here: retiring an agent-edited `x.mjs` would keep it for ever beside an `x.ts` that is the one
 * loaded, dropping the edit without a word. `migrateHarnessLayout` owns them — it removes the
 * untouched ones (recording them in the manifest's `retired` too) and renames the edited ones.
 */
export const RETIRED_SEED_PATHS: readonly string[] = [
  "skills/game-contract.md",
  "skills/self-improvement.md",
  "skills/threejs-craft.md",
  "skills/unattended-runs.md",
  "loop/facet/handover-prompts.ts",
  "loop/facet/phases/handover.ts",
  "loop/unreal/plan.ts",
  "loop/unreal/unreal-loop-prompts.ts",
  "loop/unreal/board.ts",
  "loop/unreal/checkpoint.ts",
  "loop/unreal/features.ts",
  "loop/unreal/helpers.ts",
  "loop/unreal/keep-rule.ts",
  "loop/unreal/live-graph.ts",
  "loop/unreal/live-prompts.ts",
  "loop/unreal/live-run-prompts.ts",
  "loop/unreal/live-tools.ts",
  "loop/unreal/probe-prompts.ts",
  "loop/unreal/probes.ts",
  "loop/unreal/runner.ts",
  // Renamed modules (seed-renames.ts): an untouched copy at the old path goes, an edited one moves.
  ...Object.keys(RENAMED_SEED_FILES),
];

export interface ApplySeedOptions {
  seedDir: string;
  workspaceDir: string;
  manifestFile: string;
  /** Where replaced workspace files are copied before being overwritten. */
  backupDir?: string;
  /**
   * Directory whose `seed-backup-*` children hold the seed contents earlier upgrades replaced —
   * the known vintages. A workspace file the manifest does not know but whose bytes match a
   * vintage was laid down by the app, not written by the agent, and may be upgraded.
   */
  updatesDir?: string;
  /** The running app's version, stamped into the manifest's `writer`. */
  appVersion?: string;
}

/** The `seed-backup-*` folders under `updatesDir`: every seed vintage an earlier upgrade backed up. */
async function seedBackupDirs(updatesDir: string | undefined): Promise<string[]> {
  if (!updatesDir) return [];
  const entries = await readdir(updatesDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(SEED_BACKUP_PREFIX))
    .map((entry) => path.join(updatesDir, entry.name));
}

/** sha256 of every earlier copy of `rel` that an upgrade backed up under `updatesDir`. */
async function vintageHashes(updatesDir: string | undefined, rel: string): Promise<Set<string>> {
  const hashes = new Set<string>();
  for (const dir of await seedBackupDirs(updatesDir)) {
    const file = path.join(dir, rel);
    if (await pathExists(file)) hashes.add(await hashFile(file));
  }
  return hashes;
}

/** Whether one of these files exists with exactly this hash. */
async function anyFileHashes(files: readonly string[], hash: string): Promise<boolean> {
  for (const file of files) {
    if (!(await pathExists(file))) continue;
    if ((await hashFile(file)) === hash) return true;
  }
  return false;
}

/** One boot's upgrade: its inputs, the manifest as read, and what it builds. */
interface SeedPass {
  options: ApplySeedOptions;
  /** rel → hash of the seed content last applied there; null for a pre-manifest install. */
  manifest: Record<string, string> | null;
  /** The manifest being written: rel → hash of what now stands applied there. */
  applied: Map<string, string>;
  /** Seed modules left to the layout migration (`deferredByLayout`). */
  deferred: Set<string>;
  report: SeedUpgradeReport;
}

export async function applySeed(options: ApplySeedOptions): Promise<SeedUpgradeReport> {
  const seedHashes = await hashTree(options.seedDir);

  // First launch: plain copy, then record what was laid down. An existing-but-empty directory
  // counts (boot pre-creates the whole layout before seeding runs).
  const existing = (await pathExists(options.workspaceDir)) ? await walk(options.workspaceDir) : null;
  if (existing === null || existing.length === 0) return seedEmptyWorkspace(options, seedHashes);

  const body = await readManifest(options.manifestFile);
  const manifest = body?.files ?? null;
  // Entries for paths this seed does not ship survive: an older build's seed (another branch
  // run against the same install) must not make the newer build forget it ever owned a file —
  // that once froze loop/run-inbox.mjs at its first vintage for good, every later boot reading
  // the file the app itself had laid down as "the agent's".
  const applied = new Map<string, string>(Object.entries(manifest ?? {}).filter(([rel]) => !seedHashes.has(rel)));
  const report = emptyReport(SeedUpgradeMode.Unchanged);
  if (isDowngradedManifest(body)) report.downgraded = true;
  const renamed = await carryRenamesOver(options, manifest, existing);
  if (renamed.length > 0) report.renamed = renamed;
  const seedModules = [...seedHashes.keys()].filter(isTsModule);
  const deferred = await deferredByLayout(seedModules, options.workspaceDir, body);
  const pass: SeedPass = { options, manifest, applied, deferred, report };

  for (const [rel, seedHash] of [...seedHashes.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    await applySeedFile(pass, rel, seedHash);
  }
  await finishSeedPass(pass, body);
  return report;
}

/** A report with nothing in it yet. */
function emptyReport(mode: SeedUpgradeMode): SeedUpgradeReport {
  return { mode, added: [], updated: [], kept: [], retired: [], moved: [] };
}

/** rel → sha256 of every file under `dir`, in walk order. */
async function hashTree(dir: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for (const rel of await walk(dir)) hashes.set(rel, await hashFile(path.join(dir, rel)));
  return hashes;
}

/** First launch: the whole seed copied in and recorded as laid down by the app. */
async function seedEmptyWorkspace(
  options: ApplySeedOptions,
  seedHashes: Map<string, string>,
): Promise<SeedUpgradeReport> {
  await cp(options.seedDir, options.workspaceDir, { recursive: true, force: true });
  const javascriptSeed = [...seedHashes.keys()].some(isLegacyModule);
  await writeManifest(options.manifestFile, seedHashes, {
    ...writtenBy(options),
    ...(javascriptSeed ? {} : { layoutVersion: LAYOUT_VERSION }),
  });
  // A fresh workspace is a copy of the seed, and the seed no longer ships the retired paths:
  // there is nothing to retire, and nothing to record.
  return { ...emptyReport(SeedUpgradeMode.Seeded), added: [...seedHashes.keys()].sort() };
}

/**
 * An older build of the app ran this workspace since this build (or another TypeScript one)
 * last did: its manifest has no `writer`, yet it still carries what only the TypeScript layout
 * writes — `.ts` entries, or `.mjs` modules the layout migration retired. That build could not
 * boot the TypeScript self and fell back to its own seed; what it left is migrated again below
 * and by migrateHarnessLayout, and the boot says what happened (RecoveryService).
 */
function isDowngradedManifest(body: SeedManifest | null): boolean {
  if (!body || body.writer) return false;
  const tsEntries = Object.keys(body.files).some(isTsLayoutFile);
  const retiredModules = Object.keys(body.retired ?? {}).some(isLegacyModule);
  return tsEntries || retiredModules;
}

/** The ownership rule (see the file header) for one file the seed ships. */
async function applySeedFile(pass: SeedPass, rel: string, seedHash: string): Promise<void> {
  if (pass.deferred.has(rel)) {
    await holdForLayoutMigration(pass, rel);
    return;
  }
  const target = path.join(pass.options.workspaceDir, rel);
  const targetHash = (await pathExists(target)) ? await hashFile(target) : null;
  const lastApplied = pass.manifest?.[rel] ?? null;

  if (targetHash === seedHash) {
    pass.applied.set(rel, seedHash); // already current, whoever wrote it
    return;
  }
  if (pass.manifest !== null && lastApplied === null) {
    await applyNewSeedFile(pass, rel, seedHash, targetHash);
    return;
  }
  // The check catalogue is never a winner-takes-all file: the runs write its use counts, so
  // it always differs from the seed, and a merge is the only way a shipped id reaches an
  // installed studio. It is decided BEFORE the ownership branches below because the craft
  // migration has to reach a catalogue whatever the manifest says about it — including a
  // pre-manifest install, where the old rule silently overwrote everything the runs learned.
  // The guard is what keeps the "no catalogue on disk yet" case falling through to copyIn.
  if (rel === CATALOGUE_FILE && targetHash !== null) {
    await mergeInstalledCatalogue(pass, rel, targetHash, lastApplied);
    return;
  }
  // With a manifest, `lastApplied` is known here (a brand-new file returned above); without one
  // (a pre-manifest install, which predates all self-edits) it is null and the file is the app's.
  if (lastApplied !== null && targetHash !== lastApplied) {
    keepAgentVersion(pass, rel, targetHash, lastApplied);
    return;
  }
  // Untouched since last seeding (or pre-manifest install, which predates all self-edits).
  await layDownSeedFile(pass, rel, seedHash, targetHash);
}

/** A seed module the layout migration will lay down: the manifest keeps what it knew of it until then. */
async function holdForLayoutMigration(pass: SeedPass, rel: string): Promise<void> {
  const known = pass.manifest?.[rel];
  if (known !== undefined) pass.applied.set(rel, known);
  // A pre-manifest install is the app's throughout (see the file header): its JavaScript
  // modules are recorded as laid down by the app, so the migration may replace them.
  const legacy = path.join(pass.options.workspaceDir, mjsFor(rel));
  if (pass.manifest === null && (await pathExists(legacy))) pass.applied.set(mjsFor(rel), await hashFile(legacy));
}

/**
 * Brand-new seed file. A file already at this path is the agent's — unless its bytes are
 * a seed vintage an earlier upgrade backed up, which means the app wrote it and the
 * manifest merely lost track: then it is upgraded like any untouched file.
 */
async function applyNewSeedFile(
  pass: SeedPass,
  rel: string,
  seedHash: string,
  targetHash: string | null,
): Promise<void> {
  if (targetHash !== null && !(await vintageHashes(pass.options.updatesDir, rel)).has(targetHash)) {
    pass.report.kept.push(rel);
    return;
  }
  await layDownSeedFile(pass, rel, seedHash, targetHash);
}

/** Copy the seed's `rel` in (backing up what was there) and record it as applied. */
async function layDownSeedFile(
  pass: SeedPass,
  rel: string,
  seedHash: string,
  targetHash: string | null,
): Promise<void> {
  await copyIn(pass.options, rel, targetHash);
  pass.applied.set(rel, seedHash);
  (targetHash === null ? pass.report.added : pass.report.updated).push(rel);
}

/** Merge the shipped check ids into the installed catalogue and run the craft migration on it. */
async function mergeInstalledCatalogue(
  pass: SeedPass,
  rel: string,
  targetHash: string,
  lastApplied: string | null,
): Promise<void> {
  const { options, report } = pass;
  const target = path.join(options.workspaceDir, rel);
  // Before the first destructive write, not after it: both mergeCatalogue and the craft
  // migration rewrite the file, and the backup is the whole recovery story.
  await backUp(options, rel);
  const migration = await retireMigratedCraftChecks(target, options.seedDir, options.workspaceDir);
  const merged = await mergeCatalogue(path.join(options.seedDir, rel), target);
  const notes = [
    ...merged.map((id) => `+${id}`),
    ...migration.retired.map((id) => `-${id}`),
    ...migration.refreshed.map((id) => `~${id}`),
  ];
  if (notes.length > 0) report.updated.push(`${rel} (${notes.join(", ")})`);
  else report.kept.push(rel);
  pass.applied.set(rel, lastApplied ?? targetHash);
}

/**
 * The agent changed this file since the seed was applied — its copy wins, always. Or it deleted
 * it on purpose; deleting is an edit too. Except a file only the TypeScript layout has, missing
 * while the workspace is back on JavaScript: a rewind took it, and the layout migration lays it
 * down again ("restored") — not an edit to report as kept.
 */
function keepAgentVersion(pass: SeedPass, rel: string, targetHash: string | null, lastApplied: string): void {
  const rewindTookIt = targetHash === null && restoredByMigration(pass, rel);
  if (!rewindTookIt) pass.report.kept.push(rel);
  pass.applied.set(rel, lastApplied);
}

/** Whether the layout migration will lay this missing file down again (see `keepAgentVersion`). */
function restoredByMigration(pass: SeedPass, rel: string): boolean {
  const migratedFromMjs = isTsModule(rel) && pass.manifest?.[mjsFor(rel)] !== undefined;
  return pass.deferred.size > 0 && isTsLayoutFile(rel) && !migratedFromMjs;
}

/** After every seed file: retirements, move notices, the manifest, and the report's mode. */
async function finishSeedPass(pass: SeedPass, body: SeedManifest | null): Promise<void> {
  const { options, report, deferred } = pass;
  const alreadyRetired = body?.retired ?? {};
  const retiredNow = await retireDroppedSeedFiles(options, pass.manifest, alreadyRetired, pass.applied);
  report.retired.push(...retiredNow);
  // Every boot, not only an upgrading one: the answer holds until the agent acts on it, and the
  // boot keeps the agent's note in step with it (StudioCore, seed-upgrade-notice.ts).
  report.moved.push(...(await splitMoves(options.workspaceDir, report.kept)));
  const outdated = await outdatedCalls(options.workspaceDir, report.kept);
  if (outdated.length > 0) report.outdatedCalls = outdated;
  if (deferred.size > 0) report.deferred = [...deferred].sort();

  // Files the agent grew itself live outside the manifest and are never listed or touched. A
  // workspace with nothing of the JavaScript layout left to migrate is at the current layout —
  // including one seeded as TypeScript before the manifest recorded layouts.
  await writeManifest(options.manifestFile, pass.applied, {
    ...extrasOf(body),
    ...writtenBy(options),
    retired: { ...alreadyRetired, ...Object.fromEntries(retiredNow.map((rel) => [rel, new Date().toISOString()])) },
    ...(deferred.size > 0 ? {} : { layoutVersion: LAYOUT_VERSION }),
  });
  if (report.added.length + report.updated.length + report.retired.length > 0) report.mode = SeedUpgradeMode.Upgraded;
}

/**
 * The seed's renames (seed-renames.ts), carried into the files this upgrade keeps: a module the
 * agent edited, or one it wrote itself, still says the old names, which the shipped files no
 * longer export, so the harness would not load. Each such file is rewritten in place, its original
 * backed up first; an edited copy of a renamed module moves to its new path and stays the agent's
 * there. A file the app laid down is left to the pass, which replaces or retires it. Nothing is
 * rewritten without a backup directory (the crash-recovery reseed) or a manifest (an install from
 * before self-edits), and never through a link. Answers the files it rewrote.
 */
async function carryRenamesOver(
  options: ApplySeedOptions,
  manifest: Record<string, string> | null,
  files: readonly string[],
): Promise<string[]> {
  if (!options.backupDir || manifest === null) return [];
  const rewritten: string[] = [];
  for (const [from, to] of Object.entries(RENAMED_SEED_FILES))
    if (await moveRenamedModule(options, manifest, from, to)) rewritten.push(to);
  for (const rel of files) {
    const stillThere = isTsModule(rel) && !(rel in RENAMED_SEED_FILES);
    if (stillThere && (await rewriteOldNames(options, manifest, rel))) rewritten.push(rel);
  }
  return rewritten.sort();
}

/**
 * Move the agent's copy of a renamed module to its new path, its names rewritten, where the pass
 * keeps it as the agent's: over nothing, or over the app's own untouched copy (backed up first),
 * never over a file the agent wrote there. An untouched copy at the old path is left for retirement.
 */
async function moveRenamedModule(
  options: ApplySeedOptions,
  manifest: Record<string, string>,
  from: string,
  to: string,
): Promise<boolean> {
  const text = await ownModuleText(options.workspaceDir, from);
  const lastApplied = manifest[from] ?? null;
  if (text === null || lastApplied === hashText(text)) return false;
  if (!(await replaceableByMove(options.workspaceDir, manifest, to))) return false;
  await backUp(options, from);
  await backUp(options, to);
  await writeFileNoFollow(path.join(options.workspaceDir, to), renameInSource(to, text));
  await rm(path.join(options.workspaceDir, from), { force: true });
  manifest[to] = manifest[to] ?? lastApplied ?? AGENT_WROTE;
  return true;
}

/** Nothing at `rel`, or the app's own untouched copy: what a moved module may take the place of. */
async function replaceableByMove(
  workspaceDir: string,
  manifest: Record<string, string>,
  rel: string,
): Promise<boolean> {
  if (!(await pathExists(path.join(workspaceDir, rel)))) return true;
  const text = await ownModuleText(workspaceDir, rel);
  return text !== null && manifest[rel] === hashText(text);
}

/** Rewrite the old names in one of the agent's modules; whether anything changed. */
async function rewriteOldNames(
  options: ApplySeedOptions,
  manifest: Record<string, string>,
  rel: string,
): Promise<boolean> {
  const text = await ownModuleText(options.workspaceDir, rel);
  if (text === null || manifest[rel] === hashText(text)) return false;
  const renamed = renameInSource(rel, text);
  if (renamed === text) return false;
  await backUp(options, rel);
  await writeFileNoFollow(path.join(options.workspaceDir, rel), renamed);
  return true;
}

/** A module's text, when it is a regular file inside the workspace reached through no link; else null. */
async function ownModuleText(workspaceDir: string, rel: string): Promise<string | null> {
  try {
    await containedReal(workspaceDir, rel);
    return (await readRegularFile(path.join(workspaceDir, rel), MAX_RENAMED_MODULE_BYTES)).toString("utf8");
  } catch {
    return null;
  }
}

/** The sha256 of a file's text, as `hashFile` would read it. */
const hashText = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * Remove the workspace copies of `RETIRED_SEED_PATHS` the app itself laid down.
 *
 * The manifest ENTRY survives the removal, marked in `retired`. Dropping it would make an older
 * build's seed — another branch run against the same install — read the path as brand new and
 * copy the file straight back in; with the entry present, that build takes applySeed's
 * "the agent deleted it on purpose" branch instead and leaves it gone.
 */
async function retireDroppedSeedFiles(
  options: ApplySeedOptions,
  manifest: Record<string, string> | null,
  alreadyRetired: Record<string, string>,
  applied: Map<string, string>,
): Promise<string[]> {
  // No backup directory means the caller is the crash-recovery reseed, which restores the whole
  // seed by hand and only wants the manifest re-owned. Deleting without a backup is not a thing
  // this function does.
  if (!options.backupDir) return [];
  const retired: string[] = [];
  for (const rel of RETIRED_SEED_PATHS) {
    const lastApplied = manifest?.[rel] ?? null;
    // A pre-manifest install (manifest === null) is the one-time migration, which treats the
    // whole workspace as the app's — every other file above is applied on exactly that reading.
    // The retired paths must take it too: the seed no longer ships them, so they can never
    // acquire a manifest entry, and skipping them here would strand the four dead skills in the
    // prompt index for ever, on the one boot that could still have removed them.
    if (manifest !== null && lastApplied === null) continue; // never the app's file here
    const target = path.join(options.workspaceDir, rel);
    if (!(await pathExists(target))) continue; // already gone, on this pass or an earlier one
    if (lastApplied !== null && (await hashFile(target)) !== lastApplied) continue; // the agent edited it: kept for ever
    // Retired once is retired once. A file back at this path after that was put there by
    // somebody — a rewind, a restore, a hand copy — and is not the app's to remove again.
    if (rel in alreadyRetired) continue;
    await backUp(options, rel);
    // The entry an ordinary upgrade carries over from the old manifest (see `applied` above) is
    // what makes an older build read the removal as a deliberate deletion. A pre-manifest
    // install has none, so the pass that removes the file writes it.
    if (manifest?.[rel] == null) applied.set(rel, await hashFile(target));
    await rm(target, { force: true });
    retired.push(rel);
  }
  return retired;
}

/**
 * The SEED_MOVES a kept file splits from its callers: the moved names the kept copy still
 * DEFINES (a copy that only re-exports them from the new home splits nothing), and the workspace
 * files that import one of them from the new home. Read from the files as they are after the
 * upgrade, so an agent-edited caller that still imports from the kept file counts for nothing.
 */
async function splitMoves(workspaceDir: string, kept: readonly string[]): Promise<SeedMoveNotice[]> {
  const moves = SEED_MOVES.filter((move) => kept.includes(move.from));
  if (moves.length === 0) return [];
  const loopFiles = (await walk(path.join(workspaceDir, "loop")).catch(() => [] as string[]))
    .filter((rel) => /\.(?:ts|mjs)$/.test(rel) && !rel.endsWith(".d.ts"))
    .map((rel) => `loop/${rel}`);
  const imports = new Map<string, Map<string, Set<string>>>();
  for (const rel of loopFiles)
    imports.set(rel, importedNames(rel, await readFile(path.join(workspaceDir, rel), "utf8").catch(() => "")));

  const notices: SeedMoveNotice[] = [];
  for (const move of moves) {
    const copy = await readFile(path.join(workspaceDir, move.from), "utf8").catch(() => null);
    if (copy === null) continue; // deleted by the agent: nothing of it runs anywhere
    const names = move.names.filter((name) =>
      new RegExp(`\\b(?:function\\*?|const|let|var|class)\\s+${name}\\b`).test(copy),
    );
    if (names.length === 0) continue;
    const callers = loopFiles.filter(
      (rel) => rel !== move.from && rel !== move.to && names.some((name) => imports.get(rel)?.get(move.to)?.has(name)),
    );
    if (callers.length > 0) notices.push({ from: move.from, to: move.to, names, callers });
  }
  return notices;
}

/** The kept files of SEED_CALL_CHANGES whose copy lacks the new call's marker; a deleted copy calls nothing. */
async function outdatedCalls(workspaceDir: string, kept: readonly string[]): Promise<string[]> {
  const outdated: string[] = [];
  for (const change of SEED_CALL_CHANGES) {
    if (!kept.includes(change.file)) continue;
    const copy = await readFile(path.join(workspaceDir, change.file), "utf8").catch(() => null);
    const older = copy !== null && !copy.includes(change.marker);
    if (older && !outdated.includes(change.file)) outdated.push(change.file);
  }
  return outdated;
}

/** `import { a, b as c } from "./x.mjs"` in the file at `rel` → resolved module rel → imported names. */
function importedNames(rel: string, text: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [, list = "", specifier = ""] of text.matchAll(
    /import\s*\{([^}]*)\}\s*from\s*["'](\.{1,2}\/[^"']+)["']/g,
  )) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), specifier));
    const names = out.get(target) ?? new Set<string>();
    for (const part of list.split(",")) {
      const [imported = ""] = part.trim().split(/\s+as\s+/);
      const name = imported.trim();
      if (name) names.add(name);
    }
    out.set(target, names);
  }
  return out;
}

export interface ReconcileOptions {
  workspaceDir: string;
  manifestFile: string;
  /** The seed currently shipped in the app. */
  seedDir: string;
  /** Directory whose `seed-backup-*` children hold the seed contents earlier upgrades replaced. */
  updatesDir?: string;
}

/**
 * Re-own restored seed files after a watchdog rewind of the harness workspace.
 *
 * A restore moves files *back in time* without touching the manifest, so every rewound file
 * then hashes differently from its manifest entry — and the ownership rule above reads exactly
 * that difference as "the agent edited this". One unattended run had the watchdog rewind four
 * times, after which the next boot classified the entire restored workspace as agent-owned and
 * no shipped fix could ever land again.
 *
 * The repair is conservative: a diverged file is re-owned by the app only when its current
 * content byte-matches a *known seed vintage* — the shipped seed itself, or a copy an earlier
 * upgrade backed up before replacing. Content that matches no vintage is genuinely the agent's
 * (hard constraint #1) and its manifest entry is left alone, missing files included: deletion
 * carries no bytes to match, so it stays an agent edit.
 */
export async function reconcileManifestWithSeedVintages(options: ReconcileOptions): Promise<{ reconciled: string[] }> {
  const body = await readManifest(options.manifestFile);
  const manifest = body?.files ?? null;
  if (manifest === null) return { reconciled: [] };

  // A missing backups dir is a fresh install that never upgraded — the shipped seed is then
  // the only vintage there is.
  const backupDirs = await seedBackupDirs(options.updatesDir);

  const reconciled: string[] = [];
  for (const rel of Object.keys(manifest).sort()) {
    const target = path.join(options.workspaceDir, rel);
    if (!(await pathExists(target))) continue;
    const currentHash = await hashFile(target);
    if (currentHash === manifest[rel]) continue;

    const vintages = [path.join(options.seedDir, rel), ...backupDirs.map((dir) => path.join(dir, rel))];
    if (await anyFileHashes(vintages, currentHash)) {
      manifest[rel] = currentHash;
      reconciled.push(rel);
    }
  }

  if (reconciled.length > 0) {
    await writeManifest(options.manifestFile, new Map(Object.entries(manifest)), extrasOf(body));
  }
  return { reconciled };
}

// ── the layout migration: JavaScript (1) → TypeScript (2) ─────────────────────────────────────

export interface LayoutMigrationReport {
  /** Untouched `.mjs` modules, backed up and removed; their `.ts` successor was laid down. */
  removed: string[];
  /** Agent-edited `.mjs` modules, renamed to their `.ts` path with the content preserved (these paths). */
  renamed: string[];
  /** `.mjs` modules the agent had deleted: their `.ts` successor stays deleted (these paths). */
  deleted: string[];
  /**
   * Agent-edited `.mjs` modules beside a `.ts` of the same name, which wins and is kept: never
   * loaded, so they are backed up with the other edits and taken out of the workspace.
   */
  stranded: string[];
  /**
   * Agent-edited `.mjs` modules that cannot run in the TypeScript layout (INCOMPATIBLE_WHEN_EDITED):
   * backed up with the other edits, the shipped `.ts` laid down in their place.
   */
  replaced: string[];
  /**
   * Files only the TypeScript layout has that the workspace lacked although the manifest knew them:
   * a rewind to a snapshot from before the upgrade took them away. Laid down again (these paths).
   */
  restored: string[];
  /** Workspace files whose `.mjs` import specifiers were pointed at the `.ts` modules. */
  rewritten: string[];
  /** The seed upgrade that follows, laying down every other `.ts` module. */
  seed: SeedUpgradeReport;
}

/**
 * A key for the migration as it would run now: the shipped seed and the workspace's JavaScript
 * modules. A migration whose fork failed to boot is not retried until one of them changes — the
 * next app update, or the agent editing the file that broke it.
 */
export async function layoutMigrationKey(options: Pick<ApplySeedOptions, "seedDir" | "workspaceDir">): Promise<string> {
  const hash = createHash("sha256");
  for (const rel of (await walk(options.seedDir)).sort())
    hash.update(`seed:${rel}\0${await hashFile(path.join(options.seedDir, rel))}\n`);
  for (const rel of (await walk(options.workspaceDir)).filter(isLegacyModule).sort())
    hash.update(`ws:${rel}\0${await hashFile(path.join(options.workspaceDir, rel))}\n`);
  return hash.digest("hex");
}

/**
 * Whether the workspace still has JavaScript modules to migrate — what applySeed deferred — and
 * whether a failed attempt already tried exactly this (`retry: false`).
 */
export async function layoutMigrationPending(
  options: ApplySeedOptions,
): Promise<{ key: string; retry: boolean } | null> {
  const body = await readManifest(options.manifestFile);
  const seedModules = (await walk(options.seedDir)).filter(isTsModule);
  const legacyOnly = (await walk(options.workspaceDir).catch(() => [] as string[])).filter(
    (rel) => isLegacyModule(rel) && body?.files[rel] !== undefined && !seedModules.includes(tsFor(rel)),
  );
  if ((await deferredByLayout(seedModules, options.workspaceDir, body)).size === 0 && legacyOnly.length === 0)
    return null;
  const key = await layoutMigrationKey(options);
  return { key, retry: body?.layoutAttempt?.key !== key };
}

/** Record a migration whose fork did not boot, so the same inputs are not tried again at every launch. */
export async function recordLayoutAttempt(manifestFile: string, key: string, error: string): Promise<void> {
  const body = await readManifest(manifestFile);
  if (!body) return;
  await writeManifest(manifestFile, new Map(Object.entries(body.files)), {
    ...extrasOf(body),
    layoutAttempt: { key, at: new Date().toISOString(), error: error.slice(0, LAYOUT_ERROR_MAX_CHARS) },
  });
}

/**
 * Move a workspace from the JavaScript layout to the TypeScript one, once — and again after a
 * rewind to a snapshot from before it. Per `.mjs` module the seed used to ship:
 *
 *  - untouched (its bytes are what the manifest last applied, or a backed-up seed vintage)
 *        → backed up and removed; the seed's `.ts` is laid down in its place       ("removed")
 *  - edited by the agent → renamed to `.ts`, content preserved                    ("renamed")
 *    (JavaScript is valid TypeScript under type stripping; type errors in it are reported, never
 *    fixed here) — unless a `.ts` of that name already exists, which wins: the unused `.mjs`
 *    is then backed up with the edits and removed                                  ("stranded")
 *    — or unless the edit cannot run as TypeScript at all (INCOMPATIBLE_WHEN_EDITED): backed up,
 *    and the shipped `.ts` laid down in its place                                  ("replaced")
 *  - deleted by the agent → its `.ts` stays deleted                               ("deleted")
 *
 * A file only the TypeScript layout has, which the manifest knows but the workspace lacks, was
 * taken away by a rewind to a tree from before the upgrade, and is laid down again   ("restored").
 *
 * Then every relative `.mjs` import specifier in the workspace whose module is now a `.ts` is
 * pointed at it — the agent's own tools included — and applySeed lays down the rest of the seed.
 * Edited originals are backed up outside the `seed-backup-*` vintages (they are not the app's).
 * Deterministic: a validation fork runs it first, and the live workspace only after that fork
 * booted (RecoveryService.migrateHarnessLayout).
 */
export async function migrateHarnessLayout(options: ApplySeedOptions): Promise<LayoutMigrationReport> {
  const body = await readManifest(options.manifestFile);
  const pass: LayoutPass = {
    options,
    body,
    files: new Map(Object.entries(body?.files ?? {})),
    retired: { ...(body?.retired ?? {}) },
    report: { removed: [], renamed: [], deleted: [], stranded: [], replaced: [], restored: [], rewritten: [] },
    editsBackup: editsBackupDir(options.backupDir),
    now: new Date().toISOString(),
  };

  for (const legacy of (await walk(options.workspaceDir)).filter(isLegacyModule).sort()) {
    await migrateLegacyModule(pass, legacy);
  }
  // Deleted by the agent before the migration: carry the deletion over to the successor.
  if ((body?.layoutVersion ?? 1) < LAYOUT_VERSION) await carryDeletionsOver(pass);
  await restoreTsLayoutFiles(pass);
  await pointWorkspaceAtTs(pass);

  // Done: the layout is current, and an earlier failed attempt is history.
  const { layoutAttempt: _failedBefore, ...extras } = extrasOf(body);
  await writeManifest(options.manifestFile, pass.files, {
    ...extras,
    ...writtenBy(options),
    retired: pass.retired,
    layoutVersion: LAYOUT_VERSION,
  });
  const seed = await applySeed(options);
  return { ...pass.report, seed };
}

/** One layout migration: its inputs, the manifest as it rewrites it, and what it reports. */
interface LayoutPass {
  options: ApplySeedOptions;
  body: SeedManifest | null;
  /** The manifest's file table (rel → hash) as the migration rewrites it. */
  files: Map<string, string>;
  retired: Record<string, string>;
  report: Omit<LayoutMigrationReport, "seed">;
  /** Where edited originals are copied before they are moved; null leaves every edit where it is. */
  editsBackup: string | null;
  /** When this migration ran, stamped on what it retires. */
  now: string;
}

/** `harness-edits-<stamp>` beside `seed-backup-<stamp>`: the agent's edits are not a seed vintage. */
function editsBackupDir(backupDir: string | undefined): string | null {
  if (!backupDir) return null;
  const name = path.basename(backupDir);
  const edits = name.startsWith(SEED_BACKUP_PREFIX)
    ? `${HARNESS_EDITS_PREFIX}${name.slice(SEED_BACKUP_PREFIX.length)}`
    : name;
  return path.join(path.dirname(backupDir), edits);
}

/** Whether the shipped seed has a file at `rel`. */
function seedHas(pass: LayoutPass, rel: string): Promise<boolean> {
  return pathExists(path.join(pass.options.seedDir, rel));
}

/** Lay the shipped `rel` down in the workspace and record it as the app's. */
async function layDownShipped(pass: LayoutPass, rel: string): Promise<void> {
  await copyIn(pass.options, rel, null);
  pass.files.set(rel, await hashFile(path.join(pass.options.seedDir, rel)));
}

/** One `.mjs` module: removed when untouched, otherwise moved to its `.ts` path (see migrateHarnessLayout). */
async function migrateLegacyModule(pass: LayoutPass, legacy: string): Promise<void> {
  const { options, files } = pass;
  const shipped = await seedHas(pass, tsFor(legacy));
  // Only a module the seed shipped is the migration's: an `.mjs` the agent wrote itself (a tool)
  // stays JavaScript, and only its specifiers are updated below.
  if (!shipped && files.get(legacy) === undefined) return;
  const hash = await hashFile(path.join(options.workspaceDir, legacy));
  const untouched =
    pass.body === null || files.get(legacy) === hash || (await vintageHashes(options.updatesDir, legacy)).has(hash);
  if (untouched) await removeUntouchedModule(pass, legacy, shipped);
  else await moveEditedModule(pass, legacy, shipped);
}

async function removeUntouchedModule(pass: LayoutPass, legacy: string, shipped: boolean): Promise<void> {
  const next = tsFor(legacy);
  await backUp(pass.options, legacy);
  await rm(path.join(pass.options.workspaceDir, legacy), { force: true });
  pass.retired[legacy] = pass.now;
  pass.report.removed.push(legacy);
  if (shipped && !(await pathExists(path.join(pass.options.workspaceDir, next)))) await layDownShipped(pass, next);
}

async function moveEditedModule(pass: LayoutPass, legacy: string, shipped: boolean): Promise<void> {
  // An edit is never removed without a copy; with nowhere to put one, it stays where it is.
  if (!pass.editsBackup) return;
  const next = tsFor(legacy);
  const target = path.join(pass.options.workspaceDir, legacy);
  const nextPath = path.join(pass.options.workspaceDir, next);
  await mkdir(path.dirname(path.join(pass.editsBackup, legacy)), { recursive: true });
  await cp(target, path.join(pass.editsBackup, legacy), { force: true });
  if (await pathExists(nextPath)) {
    // Left beside the `.ts` it would stay unused for ever, and keep this migration pending.
    await rm(target, { force: true });
    pass.report.stranded.push(legacy);
    return;
  }
  if (INCOMPATIBLE_WHEN_EDITED.has(legacy) && shipped) {
    await rm(target, { force: true });
    await layDownShipped(pass, next);
    pass.report.replaced.push(legacy);
    return;
  }
  await cp(target, nextPath, { force: true });
  await rm(target, { force: true });
  // What the manifest last applied at the old path, which the edited content is not — or, for
  // a module the agent wrote at a path the seed now ships, no hash at all: either way the
  // upgrade that follows reads the renamed file as the agent's and keeps it.
  pass.files.set(next, pass.files.get(legacy) ?? AGENT_WROTE);
  pass.report.renamed.push(next);
}

/** A shipped `.mjs` module the agent deleted before the migration: its `.ts` successor stays deleted. */
async function carryDeletionsOver(pass: LayoutPass): Promise<void> {
  for (const [legacy, lastApplied] of [...pass.files.entries()].sort()) {
    const successor = tsFor(legacy);
    if (!isLegacyModule(legacy) || pass.files.has(successor)) continue;
    if (!(await seedHas(pass, successor))) continue;
    if (await pathExists(path.join(pass.options.workspaceDir, legacy))) continue;
    pass.files.set(successor, lastApplied);
    pass.report.deleted.push(successor);
  }
}

/**
 * A rewind to a snapshot from before the upgrade (reset and clean) takes away every file only
 * the TypeScript layout has — the modules with no `.mjs` predecessor (loop/git.ts, loop/config.ts
 * …), types/, tsconfig.json — while their manifest entries survive it. applySeed reads such an
 * entry with no file as the agent's deletion and keeps it deleted, so every migration after the
 * rewind booted a main.ts importing modules that were not there, failed, and left the install on
 * JavaScript for good. The restored tree never had them: they are the migration's to lay down
 * again. A successor of an `.mjs` the manifest knows is not one of them — its deletion is carried
 * over above — and neither is a file the seed no longer ships.
 */
async function restoreTsLayoutFiles(pass: LayoutPass): Promise<void> {
  for (const rel of [...pass.files.keys()].sort()) {
    if (!isRestorableLayoutFile(pass, rel)) continue;
    if (!(await seedHas(pass, rel)) || (await pathExists(path.join(pass.options.workspaceDir, rel)))) continue;
    // Before the specifiers below are pointed at `.ts` modules: only a module that exists is one.
    await layDownShipped(pass, rel);
    pass.report.restored.push(rel);
  }
}

/** A file only the TypeScript layout has, which no `.mjs` predecessor or carried deletion accounts for. */
function isRestorableLayoutFile(pass: LayoutPass, rel: string): boolean {
  if (!isTsLayoutFile(rel) || pass.report.deleted.includes(rel)) return false;
  return !(isTsModule(rel) && pass.files.has(mjsFor(rel)));
}

/** Point every workspace module's relative `.mjs` specifiers at the `.ts` modules now in place. */
async function pointWorkspaceAtTs(pass: LayoutPass): Promise<void> {
  const { workspaceDir } = pass.options;
  const modules = (await walk(workspaceDir))
    .filter((file) => /\.(?:ts|mts|mjs|js)$/.test(file) && !file.endsWith(".d.ts"))
    .sort();
  for (const rel of modules) {
    const file = path.join(workspaceDir, rel);
    const text = await readFile(file, "utf8");
    const rewritten = await pointSpecifiersAtTs(workspaceDir, rel, text);
    if (rewritten === text) continue;
    await writeFile(file, rewritten);
    pass.report.rewritten.push(rel);
  }
}

/**
 * `text` (the workspace file `rel`) with every relative `.mjs` specifier — static and dynamic
 * imports, re-exports — whose module no longer exists but whose `.ts` does, spelled `.ts`.
 */
async function pointSpecifiersAtTs(workspaceDir: string, rel: string, text: string): Promise<string> {
  const pattern = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"'\n]*?)\.mjs\2/g;
  const replacements = new Map<string, string>();
  for (const match of text.matchAll(pattern)) {
    const specifier = `${match[3]}.mjs`;
    if (replacements.has(specifier)) continue;
    const module = path.join(workspaceDir, path.dirname(rel), specifier);
    if (!isBelow(workspaceDir, module)) continue;
    if (!(await pathExists(module)) && (await pathExists(module.replace(/\.mjs$/, ".ts"))))
      replacements.set(specifier, `${match[3]}.ts`);
  }
  if (replacements.size === 0) return text;
  return text.replace(pattern, (whole, lead: string, quote: string, stem: string) => {
    const to = replacements.get(`${stem}.mjs`);
    return to ? `${lead}${quote}${to}${quote}` : whole;
  });
}

/**
 * The crash-recovery reseed (and the user's reset) lays the shipped TypeScript self over the
 * workspace: the JavaScript modules it replaces would otherwise stay behind for ever, and the next
 * boot would read an edited one as something to migrate over the fresh `.ts`. They are backed up
 * (outside the seed vintages — they may be the agent's) and removed. Returns what was removed.
 */
export async function removeLegacyModules(options: {
  seedDir: string;
  workspaceDir: string;
  backupDir: string;
}): Promise<string[]> {
  const removed: string[] = [];
  for (const legacy of (await walk(options.workspaceDir)).filter(isLegacyModule).sort()) {
    if (!(await pathExists(path.join(options.seedDir, tsFor(legacy))))) continue;
    const target = path.join(options.workspaceDir, legacy);
    await mkdir(path.dirname(path.join(options.backupDir, legacy)), { recursive: true });
    await cp(target, path.join(options.backupDir, legacy), { force: true });
    await rm(target, { force: true });
    removed.push(legacy);
  }
  return removed;
}

/** The check catalogue: merged on upgrade, never overwritten (see applySeed). */
export const CATALOGUE_FILE = "library/checks.json";

/**
 * Copy into `targetFile` every check id `seedFile` has and the target lacks — except one the
 * migration has retired, which is absent on purpose. Returns the ids added. A target that does
 * not parse is left alone (its owner will notice; the seed must not destroy a hand-edited
 * catalogue over a comma).
 */
export async function mergeCatalogue(seedFile: string, targetFile: string): Promise<string[]> {
  const seed = await readJsonIfExists<Catalogue>(seedFile);
  const target = await readJsonIfExists<Catalogue>(targetFile);
  const seedChecks = seed?.checks;
  const mergeable = isObjectValue(seedChecks) && isObjectValue(target);
  if (!mergeable) return [];
  const checks = isObjectValue(target.checks) ? target.checks : {};
  const retired = isObjectValue(target.retired) ? target.retired : {};
  const added: string[] = [];
  for (const [id, entry] of Object.entries(seedChecks)) {
    // An id the migration moved into `retired` is not missing — it was taken off the board on
    // purpose, and copying it back in would undo the migration on every boot.
    if (id in checks || id in retired) continue;
    checks[id] = entry;
    added.push(id);
  }
  if (added.length === 0) return [];
  await writeCatalogue(targetFile, checks, retired);
  return added;
}

type Catalogue = { version?: number; checks?: Record<string, unknown>; retired?: Record<string, unknown> };

/** Present and an object (arrays included, as the catalogue has always read them). */
function isObjectValue<T extends object>(value: T | null | undefined): value is T {
  return Boolean(value) && typeof value === "object";
}

/** Write a catalogue back at version 2, ids sorted, the retired map preserved (and only then). */
async function writeCatalogue(
  file: string,
  checks: Record<string, unknown>,
  retired: Record<string, unknown>,
): Promise<void> {
  const sort = (map: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : 1)));
  const body: Catalogue = { version: CATALOGUE_VERSION, checks: sort(checks) };
  if (Object.keys(retired).length > 0) body.retired = sort(retired);
  await atomicWriteJson(file, body);
}

/**
 * Craft ids a recipe library owns: `check id → recipe id`, read from a `library/recipes`
 * directory. The retirement list is derived from this and from nothing else, so an id can never
 * be taken off an installed catalogue without somewhere to retrieve it from again — which is why
 * it is asked of BOTH libraries: the seed's (what this build considers craft) and the install's
 * own (what a planner on this machine can actually retrieve).
 */
export async function craftCheckOwners(rootDir: string): Promise<Map<string, string>> {
  const dir = path.join(rootDir, "library", "recipes");
  const owners = new Map<string, string>();
  for (const entry of (await readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const body = await readJsonIfExists<{ id?: unknown; kind?: unknown; check?: { id?: unknown } }>(
      path.join(dir, entry.name),
    );
    if (body?.kind !== "craft") continue;
    const checkId = typeof body.check?.id === "string" ? body.check.id : "";
    const recipeId = typeof body.id === "string" ? body.id : "";
    // The first recipe (by file name) to claim a check owns it.
    const unclaimed = checkId !== "" && recipeId !== "" && !owners.has(checkId);
    if (unclaimed) owners.set(checkId, recipeId);
  }
  return owners;
}

/**
 * Seed ids the seed dropped by RENAME rather than by retirement. Without this a superseded id
 * has no craft recipe to point at, survives every rule below, and goes on being rendered to
 * every planner for ever under a heading about what some other game learned.
 */
export const SUPERSEDED_CHECKS: Record<string, string> = { "fire-registers": "primary-action-registers" };

/** What a refresh may overwrite on a kept entry: the definition, never the statistics. */
const CHECK_DEFINITION_FIELDS = [
  "kind",
  "js",
  "expr",
  "name",
  "ask",
  "camera",
  "crop",
  "detail",
  "weight",
  "needs",
  "note",
  "optional",
  "expect",
  "demo",
] as const;

export interface CraftMigrationReport {
  /** Seed-origin ids moved into `retired`, whole, with every statistic they had. */
  retired: string[];
  /** Seed-origin ids the seed still ships whose definition was brought up to date. */
  refreshed: string[];
}

/**
 * Move the craft opinions out of an installed catalogue, and bring the survivors up to date.
 *
 * The catalogue on a machine that has had runs is a mixture: entries the seed put there,
 * entries a planner wrote, entries a judge grew. Only the first kind is the seed's to move,
 * so `origin: "seed"` is the gate, and a planner-written entry that happens to share an id is
 * left exactly as it is. An entry the seed still ships is not retired but REFRESHED — its
 * definition is taken from the seed while its uses, passes, catches, runs and last-used
 * timestamp survive — because otherwise an install keeps for ever the two bodies this change
 * exists to correct. Everything else that has a craft recipe (or a named successor) MOVES,
 * whole, into `retired`, and the move is idempotent: a second pass finds nothing left to do
 * and the first pass's `retiredAt` is never restamped.
 */
export async function retireMigratedCraftChecks(
  catalogueFile: string,
  seedDir: string,
  workspaceDir: string | null = null,
): Promise<CraftMigrationReport> {
  const report: CraftMigrationReport = { retired: [], refreshed: [] };
  const target = await readJsonIfExists<Catalogue>(catalogueFile);
  if (!hasCheckMap(target)) return report;
  const seed = await readJsonIfExists<Catalogue>(path.join(seedDir, CATALOGUE_FILE));
  const shipped = objectOrEmpty(seed?.checks) as Record<string, Record<string, unknown>>;
  const owners = await craftCheckOwners(seedDir);
  // A seed that ships no recipes at all cannot be the authority on what to retire.
  if (owners.size === 0) return report;
  // Nor can it be the only authority. Every retrieval path — the planner's craft menu, a plan
  // that names a recipe id, THE FIX's named recipe — reads the INSTALL's `library/recipes`, and
  // a recipe the agent has edited keeps its own copy for ever (the ownership rule), which on a
  // machine that has had runs means a recipe written before craft existed: `kind` absent, so
  // `normalizeRecipe` reads it as a technique and no craft path can see it. Retiring against the
  // seed alone struck twelve opinions off such an install with nothing left to answer for them.
  // An untouched recipe is upgraded later in this same pass (library/checks.json sorts before
  // library/recipes/*), so its check retires on the next boot rather than this one.
  const installed = await installedCraftOwners(workspaceDir, owners);

  const checks = target.checks as Record<string, Record<string, unknown>>;
  const retired = objectOrEmpty(target.retired);
  const at = new Date().toISOString();

  for (const id of Object.keys(checks).sort()) {
    const entry = checks[id];
    if (!isSeedCheck(entry)) continue;

    const stillShipped = shipped[id];
    if (stillShipped) {
      if (refreshCheckDefinition(entry, stillShipped)) report.refreshed.push(id);
      continue;
    }

    const retiredTo = retirementTarget(id, owners, installed);
    if (!retiredTo) continue; // nowhere to retrieve it from: it stays on the board
    if (!(id in retired)) retired[id] = { ...entry, retiredAt: at, retiredTo, retiredBy: "seed-upgrade" };
    delete checks[id];
    report.retired.push(id);
  }

  if (report.retired.length + report.refreshed.length === 0) return report;
  await writeCatalogue(catalogueFile, checks, retired);
  return report;
}

/** The craft owners the install's own library holds; the seed's when there is no workspace to read. */
function installedCraftOwners(
  workspaceDir: string | null,
  seedOwners: Map<string, string>,
): Promise<Map<string, string>> {
  return workspaceDir === null ? Promise.resolve(seedOwners) : craftCheckOwners(workspaceDir);
}

/** A catalogue that parsed into an object with a `checks` map. */
function hasCheckMap(target: Catalogue | null): target is Catalogue & { checks: Record<string, unknown> } {
  return isObjectValue(target) && isObjectValue(target.checks);
}

/** `value` when it is a (truthy) object, else a fresh empty one. */
function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * Where a seed check that is no longer shipped retires to, or null when nothing answers for it.
 * The seed says a craft recipe answers for this id; the install says whether it holds one.
 * A rename (SUPERSEDED_CHECKS) needs no recipe — the successor is an id on the same board.
 */
function retirementTarget(id: string, owners: Map<string, string>, installed: Map<string, string>): string | null {
  const recipeHolds = owners.has(id) ? installed.get(id) : undefined;
  return recipeHolds ?? SUPERSEDED_CHECKS[id] ?? null;
}

/** A catalogue entry the seed put there (`origin: "seed"`): the only kind the seed may move. */
function isSeedCheck(entry: unknown): entry is Record<string, unknown> {
  return typeof entry === "object" && entry !== null && (entry as { origin?: unknown }).origin === "seed";
}

/**
 * Bring a kept seed entry's definition up to the shipped one (CHECK_DEFINITION_FIELDS), leaving
 * its statistics alone. True when anything changed.
 */
function refreshCheckDefinition(entry: Record<string, unknown>, shipped: Record<string, unknown>): boolean {
  let changed = false;
  for (const field of CHECK_DEFINITION_FIELDS) {
    const wanted = shipped[field];
    if (wanted === undefined) {
      if (field in entry) {
        delete entry[field];
        changed = true;
      }
      continue;
    }
    if (JSON.stringify(entry[field]) !== JSON.stringify(wanted)) {
      entry[field] = wanted;
      changed = true;
    }
  }
  return changed;
}

/** Copy the workspace's current `rel` into the backup dir, before anything rewrites it. */
async function backUp(options: ApplySeedOptions, rel: string): Promise<void> {
  if (!options.backupDir) return;
  const target = path.join(options.workspaceDir, rel);
  if (!(await pathExists(target))) return;
  const backup = path.join(options.backupDir, rel);
  await mkdir(path.dirname(backup), { recursive: true });
  await cp(target, backup, { force: true });
}

async function copyIn(options: ApplySeedOptions, rel: string, previousHash: string | null): Promise<void> {
  const target = path.join(options.workspaceDir, rel);
  if (previousHash !== null) await backUp(options, rel);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.join(options.seedDir, rel), target, { force: true });
}

async function writeManifest(file: string, hashes: Map<string, string>, extras: ManifestExtras = {}): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const body: SeedManifest = { files: Object.fromEntries([...hashes.entries()].sort()) };
  const retired = extras.retired ?? {};
  if (Object.keys(retired).length > 0)
    body.retired = Object.fromEntries(Object.entries(retired).sort(([a], [b]) => (a < b ? -1 : 1)));
  if (extras.layoutVersion !== undefined) body.layoutVersion = extras.layoutVersion;
  if (extras.layoutAttempt) body.layoutAttempt = extras.layoutAttempt;
  // Every write is this build's (see `writer`), whichever path made it.
  body.writer = { layout: LAYOUT_VERSION, ...(extras.writer?.app ? { app: extras.writer.app } : {}) };
  await atomicWriteJson(file, body);
}

/** The `writer` extra for a write that knows the app's version; without one, the last version known is kept. */
function writtenBy(options: Pick<ApplySeedOptions, "appVersion">): Pick<ManifestExtras, "writer"> {
  return options.appVersion ? { writer: { layout: LAYOUT_VERSION, app: options.appVersion } } : {};
}

async function walk(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await walk(path.join(dir, entry.name), rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

async function hashFile(file: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}
