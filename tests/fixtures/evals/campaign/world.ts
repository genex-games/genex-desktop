/**
 * A hermetic campaign world for the scheduler and CLI tests: an evals home under a caller's root,
 * fake lanes that replay the fixture streams (raw) or seed and edit a game with a lane report
 * (Genex), the real canary judge over a fake server and a scripted boot probe, manual watch timers
 * and the real ledger writer. Every value is invented; nothing touches a provider or the network.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type CanaryInput, createCanaryJudge } from "../../../../scripts/evals/campaign/canary.ts";
import { machineFacts } from "../../../../scripts/evals/campaign/row.ts";
import type { CampaignRunDeps } from "../../../../scripts/evals/campaign/run.ts";
import { parseCases } from "../../../../scripts/evals/cases.ts";
import type { BootProbeResult, ServeHandle } from "../../../../scripts/evals/grade/types.ts";
import { createRunWorkspace } from "../../../../scripts/evals/lanes/common.ts";
import { evalsLayout } from "../../../../scripts/evals/lanes/homes.ts";
import { validateLaneRegistry } from "../../../../scripts/evals/lanes/registry.ts";
import type { LaneRunRequest, LaneRunResult } from "../../../../scripts/evals/lanes/types.ts";
import { evalsPaths } from "../../../../scripts/evals/ledger/paths.ts";
import { currentRows, readRunRows } from "../../../../scripts/evals/ledger/read.ts";
import type { RunRow } from "../../../../scripts/evals/ledger/types.ts";
import { appendLedgerRow } from "../../../../scripts/evals/ledger/write.ts";
import { validatePriceTable } from "../../../../scripts/evals/prices.ts";
import {
  CheckResult,
  EndedHow,
  EvalAgent,
  type HarnessFailure,
  LaneModeServed,
  LaunchPath,
  RendererMode,
  ServedVia,
} from "../../../../scripts/evals/vocabulary.ts";
import { defaultHomes } from "../../../../scripts/transcript-census.ts";
import { EVAL_LANE_REPORT_SCHEMA, type EvalLaneReport } from "../../../../src/shared/eval-lane.ts";
import { PermissionMode } from "../../../../src/shared/permissions.ts";
import { EngineId } from "../../../../src/shared/providers.ts";
import { workspaceDigest } from "../../../../src/substrate/workspace-digest.ts";

/** The evals fixture folder. */
export const FIXTURES = path.resolve(import.meta.dirname, "..");
export const CASES = parseCases(fs.readFileSync(path.join(FIXTURES, "campaign/cases.md"), "utf8"));
export const REGISTRY = validateLaneRegistry(
  JSON.parse(fs.readFileSync(path.join(FIXTURES, "campaign/lanes.json"), "utf8")),
);
export const STREAMS = {
  [EngineId.ClaudeCode]: fs.readFileSync(path.join(FIXTURES, "lanes/claude-stream.jsonl"), "utf8"),
  [EngineId.Codex]: fs.readFileSync(path.join(FIXTURES, "lanes/codex-stream.jsonl"), "utf8"),
} as const;
export const CLI_VERSION = { [EngineId.ClaudeCode]: "2.1.284", [EngineId.Codex]: "0.155.0" } as const;
export const PRICES = validatePriceTable({
  schema: "genex-evals/prices/1",
  asOf: "2026-09-25",
  unit: "usd-per-million-tokens",
  models: {
    "claude-opus-5-5": { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 },
    "gpt-6.1-sol": { unknown: true },
  },
});
export const BASE = "a".repeat(40);
export const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
export const SEED_POLL_MS = 1;
export const SNAPSHOT_MS = 2;
export const TEMPLATE_PAGE = "<!doctype html><title>__seeded__</title>";

let homeCount = 0;

/** A fake lane's script: what it does per run id. */
export interface LaneScript {
  /** The harness failure a run reports; `index` counts lane calls from 1, across both providers. */
  failure?: (request: LaneRunRequest, index: number) => HarnessFailure | null;
  cliVersion?: (request: LaneRunRequest, index: number) => string;
  /** A Genex run that seeds and never edits. */
  untouched?: (request: LaneRunRequest) => boolean;
  /** A Genex run whose agent edits the seeded game at once, before the campaign's seed poll could land. */
  editsAtOnce?: (request: LaneRunRequest) => boolean;
  /** A raw run that writes no page. */
  noPage?: (request: LaneRunRequest) => boolean;
  /** The lane runner itself throws (a scheduler-level fault, not a harness failure). */
  crash?: (request: LaneRunRequest) => boolean;
}

/** A manual timer: the watch's polls and ticks fire only when the fake lane fires them. */
function manualTimers() {
  const entries = new Set<{ tick: () => void; ms: number }>();
  return {
    every: (tick: () => void, ms: number) => {
      const entry = { tick, ms };
      entries.add(entry);
      return () => entries.delete(entry);
    },
    fire: (ms: number) => {
      for (const entry of [...entries]) if (entry.ms === ms) entry.tick();
    },
    has: (ms: number) => [...entries].some((entry) => entry.ms === ms),
  };
}

/** What the fake lanes and the fake prober of one world share. */
interface WorldContext {
  script: LaneScript;
  userHome: string;
  timers: ReturnType<typeof manualTimers>;
  now: () => number;
  calls: string[];
  active: Map<string, number>;
  stats: {
    maxPerEngine: number;
    maxOverall: number;
    builtApps: string[];
    served: string[];
    vendors: string[];
    lines: string[];
    /** Each run's lane root (where its agent ran), by run id. */
    laneRoots: Map<string, string>;
  };
}

type ArtifactsAt = Pick<LaneRunResult["artifacts"], "projectDir" | "streamPath" | "eventLogDir" | "reportPath"> & {
  startedAt: number;
};

/** The result a fake lane reports, with the script's harness failure and CLI version. */
function fakeResult(ctx: WorldContext, request: LaneRunRequest, index: number, at: ArtifactsAt): LaneRunResult {
  const failure = ctx.script.failure?.(request, index) ?? null;
  const engine = request.lane.engine === EngineId.Codex ? EngineId.Codex : EngineId.ClaudeCode;
  return {
    runId: request.runId,
    artifacts: {
      workRoot: request.workRoot,
      laneRoot: request.laneRoot,
      projectDir: at.projectDir,
      streamPath: at.streamPath,
      stdoutPath: path.join(request.workRoot, "stdout.log"),
      stderrPath: path.join(request.workRoot, "stderr.log"),
      transcriptHomes: request.homes,
      snapshotDir: path.join(request.workRoot, "snapshots"),
      finalSnapshotDir: null,
      eventLogDir: at.eventLogDir,
      reportPath: at.reportPath,
      specPath: null,
    },
    startedAt: new Date(at.startedAt).toISOString(),
    endedAt: new Date(ctx.now()).toISOString(),
    endedHow: failure ? EndedHow.HarnessFailure : EndedHow.AgentFinished,
    harnessFailure: failure,
    noBuild: null,
    exitCode: 0,
    signal: null,
    cliVersion: ctx.script.cliVersion?.(request, index) ?? CLI_VERSION[engine],
    questionsAsked: 0,
    answersGiven: 0,
    quotaBefore: null,
    quotaAfter: null,
    contaminationClean: true,
  };
}

/** A raw lane: the fixture stream stored as the supervisor stores it, and a page (or only notes). */
async function fakeRawLane(ctx: WorldContext, request: LaneRunRequest, index: number): Promise<LaneRunResult> {
  const { projectDir } = await createRunWorkspace(request.workRoot, ctx.userHome, request.laneRoot);
  const startedAt = ctx.now();
  const streamPath = path.join(request.workRoot, "stream.jsonl");
  const lines = STREAMS[request.lane.engine === EngineId.Codex ? EngineId.Codex : EngineId.ClaudeCode]
    .trim()
    .split("\n");
  const records = lines.map((line, at) => JSON.stringify({ receivedAt: startedAt + (at + 1) * 100, line }));
  await writeFile(streamPath, `${records.join("\n")}\n`);
  if (ctx.script.noPage?.(request)) await writeFile(path.join(projectDir, "README.md"), "notes");
  else await writeFile(path.join(projectDir, "index.html"), "<canvas></canvas>");
  return fakeResult(ctx, request, index, { projectDir, streamPath, startedAt, eventLogDir: null, reportPath: null });
}

/**
 * A Genex lane: the app seeds the template and reports its digest (as the real lane does when the
 * chat is bound), the campaign's seed poll finds the game and starts the watcher, then the agent
 * edits it (or not; or at once, before any poll).
 */
async function fakeGenexLane(ctx: WorldContext, request: LaneRunRequest, index: number): Promise<LaneRunResult> {
  await createRunWorkspace(request.workRoot, ctx.userHome, request.laneRoot);
  const gameDir = path.join(request.laneRoot, "games", "game-1");
  await mkdir(gameDir, { recursive: true });
  await writeFile(path.join(gameDir, "index.html"), TEMPLATE_PAGE);
  const templateDigest = await workspaceDigest(gameDir);
  const edit = () => writeFile(path.join(gameDir, "index.html"), "<canvas id=game></canvas>");
  const atOnce = ctx.script.editsAtOnce?.(request) === true;
  if (atOnce) await edit();
  // The seed poll ends once the snapshot watcher runs on the seeded game.
  for (let tries = 0; tries < 200 && ctx.timers.has(SEED_POLL_MS); tries++) {
    ctx.timers.fire(SEED_POLL_MS);
    await delay(2);
  }
  if (!atOnce && !ctx.script.untouched?.(request)) await edit();
  const startedAt = ctx.now();
  const reportPath = path.join(request.laneRoot, "lane-report.json");
  const report = { ...laneReport(request, gameDir, startedAt, ctx.now()), templateDigest };
  await writeFile(reportPath, JSON.stringify(report));
  const eventLogDir = path.join(request.laneRoot, "userdata");
  return fakeResult(ctx, request, index, { projectDir: gameDir, streamPath: null, startedAt, eventLogDir, reportPath });
}

/** The lane runner: counts how many runs of each provider (and in all) overlap, then runs the fake lane. */
function fakeRunLane(ctx: WorldContext): CampaignRunDeps["runLane"] {
  return async (request) => {
    const engine = request.lane.engine;
    ctx.active.set(engine, (ctx.active.get(engine) ?? 0) + 1);
    ctx.stats.maxPerEngine = Math.max(ctx.stats.maxPerEngine, ctx.active.get(engine) ?? 0);
    const overall = [...ctx.active.values()].reduce((a, b) => a + b, 0);
    ctx.stats.maxOverall = Math.max(ctx.stats.maxOverall, overall);
    ctx.calls.push(request.runId);
    ctx.stats.laneRoots.set(request.runId, request.laneRoot);
    if (ctx.script.crash?.(request)) {
      ctx.active.set(engine, (ctx.active.get(engine) ?? 1) - 1);
      throw new Error("lane runner fault");
    }
    try {
      await delay(3);
      const index = ctx.calls.length;
      if (request.lane.agent === EvalAgent.GenexApp) return await fakeGenexLane(ctx, request, index);
      return await fakeRawLane(ctx, request, index);
    } finally {
      ctx.active.set(engine, (ctx.active.get(engine) ?? 1) - 1);
    }
  };
}

/** The real canary judge over a fake server (it records what it served) and a scripted boot probe. */
function fakeCanaryJudge(ctx: WorldContext, base: string, probe: (input: CanaryInput) => CheckResult) {
  const pending = new Map<string, CanaryInput>();
  const served = new Map<string, CanaryInput>();
  const judge = createCanaryJudge({
    serve: async (options): Promise<ServeHandle> => {
      ctx.stats.served.push(options.root);
      ctx.stats.vendors.push(options.vendorDir);
      const url = `http://127.0.0.1:9/${ctx.stats.served.length}`;
      const input = [...pending.values()].find((candidate) => candidate.finalSnapshotDir === options.root);
      assert.ok(input, "the canary serves its own stop-time snapshot");
      served.set(url, input);
      return {
        url,
        origin: "http://127.0.0.1:9",
        root: options.root,
        servedVia: ServedVia.AsIs,
        noBuild: null,
        close: async () => {},
      };
    },
    probeBoot: async (url, options): Promise<BootProbeResult> => {
      const input = served.get(url);
      assert.ok(input);
      // The boot probe keeps its frame in the run's evidence folder, as the real one does.
      if (options.evidenceDir) {
        await mkdir(options.evidenceDir, { recursive: true });
        await writeFile(path.join(options.evidenceDir, "boot.png"), "frame");
      }
      return {
        booted: probe(input),
        firstRenderMs: 120,
        uncaughtBeforeFirstDraw: false,
        degenerateCanvas: false,
        rendererMode: RendererMode.Gpu,
        servedVia: ServedVia.AsIs,
        consoleErrors: 0,
        frames: [],
      };
    },
    vendorDir: path.join(base, "vendor"),
    npmCacheDir: path.join(base, "npm-cache"),
  });
  return async (input: CanaryInput) => {
    pending.set(input.runId, input);
    return judge(input);
  };
}

/** A test campaign's world: an evals home, fake lanes, a fake prober and the real ledger. */
export function campaignWorld(
  root: string,
  script: LaneScript = {},
  probe: (input: CanaryInput) => CheckResult = () => CheckResult.Pass,
) {
  homeCount += 1;
  const base = path.join(root, `world-${homeCount}`);
  const home = path.join(base, "evals");
  // The lanes folder sits beside the evals home, never inside it, as the machine's does under the temp folder.
  const layout = evalsLayout(home, path.join(base, "lanes"));
  const paths = evalsPaths(home);
  let clock = NOW;
  const ctx: WorldContext = {
    script,
    userHome: path.join(base, "user"),
    timers: manualTimers(),
    now: () => {
      clock += 1000;
      return clock;
    },
    calls: [],
    active: new Map(),
    stats: {
      maxPerEngine: 0,
      maxOverall: 0,
      builtApps: [],
      served: [],
      vendors: [],
      lines: [],
      laneRoots: new Map(),
    },
  };
  const deps: CampaignRunDeps = {
    paths,
    layout,
    cases: CASES,
    startDir: () => null,
    registry: REGISTRY,
    prices: PRICES,
    clock: {
      now: ctx.now,
      sleep: async (ms) => {
        clock += ms;
      },
    },
    runLane: fakeRunLane(ctx),
    buildApp: async (sha) => {
      ctx.stats.builtApps.push(sha);
      return { sha, dir: path.join(layout.builds, sha), dirty: false };
    },
    readQuota: async () => null,
    judgeCanary: fakeCanaryJudge(ctx, base, probe),
    appendRow: async (row) => {
      await appendLedgerRow(row, { paths, homes: defaultHomes(ctx.userHome) });
    },
    readRows: () => readRunRows(paths),
    machine: machineFacts("1234567"),
    userHome: ctx.userHome,
    watch: { every: ctx.timers.every, seedPollMs: SEED_POLL_MS, intervalMs: SNAPSHOT_MS },
    out: (line) => ctx.stats.lines.push(line),
  };
  const rows = async (campaignId: string): Promise<RunRow[]> =>
    currentRows((await readRunRows(paths)).filter((row) => row.campaignId === campaignId));
  return { deps, calls: ctx.calls, stats: ctx.stats, rows, home, layout, paths, base };
}

function laneReport(request: LaneRunRequest, projectDir: string, startedAt: number, endedAt: number): EvalLaneReport {
  return {
    schema: EVAL_LANE_REPORT_SCHEMA,
    runId: request.runId,
    laneId: request.lane.id,
    caseId: request.evalCase.id,
    engine: request.lane.engine,
    modelRequested: request.lane.model,
    modelServed: request.lane.model,
    effort: request.lane.effort,
    effortServed: request.lane.effort,
    appVersion: "0.0.0",
    harnessDigest: { workspace: "c".repeat(64), shipped: "c".repeat(64), matches: true },
    projectDir,
    templateDigest: null,
    threadId: "thread-1",
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    endedHow: EndedHow.AgentFinished,
    launch: LaunchPath.None,
    budgets: { completionPolicy: null },
    runIds: [],
    permissionModeServed: PermissionMode.Auto,
    modeServed: LaneModeServed.AutopilotUntilSatisfied,
    commissionSent: {},
    questionsAsked: 0,
    answers: [],
    firstPreviewProxyMs: null,
    cliVersions: { claude: CLI_VERSION[EngineId.ClaudeCode], codex: null },
    fixture: false,
    errors: [],
  };
}
