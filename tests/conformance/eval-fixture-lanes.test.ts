/**
 * The fixture lanes run the whole eval pipeline with no provider (§13.8). The Genex fixture lanes
 * (A/D) ask the app's scripted fixture engines for a model those engines list, so the eval
 * launch's preflight never refuses them. The raw fixture lanes (B/C) resolve the stub CLIs in
 * `tests/fixtures/evals/bin`, never the machine's own. Run through the real raw lane runner and a
 * real process group, each stub replays a recorded, redacted stream with its receive timing, writes
 * the recorded game and its CLI's transcript into the eval home, and the typed guards find nothing
 * wrong. No provider, network or app is started.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { EvalCase } from "../../scripts/evals/case-types.ts";
import { collectRun } from "../../scripts/evals/campaign/collect.ts";
import { systemLaneRunner } from "../../scripts/evals/campaign/commands.ts";
import { ANSWER_POLICY, readStreamRecords, SYSTEM_SUPERVISOR } from "../../scripts/evals/lanes/common.ts";
import { fixtureStubPath, fixtureStubResolver, laneCliResolver } from "../../scripts/evals/lanes/fixture-stubs.ts";
import { type RawLaneDeps, runRawLane } from "../../scripts/evals/lanes/raw.ts";
import { evalsLayout } from "../../scripts/evals/lanes/homes.ts";
import { readLaneRegistry } from "../../scripts/evals/lanes/registry.ts";
import type { LaneRegistryRow, LaneRunRequest } from "../../scripts/evals/lanes/types.ts";
import { readPriceTable } from "../../scripts/evals/prices.ts";
import {
  CaseExposure,
  CaseMode,
  CaseVisibility,
  Coverage,
  EndedHow,
  EvalAgent,
} from "../../scripts/evals/vocabulary.ts";
import { fixtureEngines } from "../../src/main/dev/fixture-engines.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { EngineId } from "../../src/shared/providers.ts";

const repo = path.resolve(import.meta.dirname, "../..");
const registry = readLaneRegistry(repo);
const fixtureLanes = registry.lanes.filter((lane) => lane.fixture);
const rawFixture = (engine: EngineId): LaneRegistryRow => {
  const lane = fixtureLanes.find((row) => row.agent !== EvalAgent.GenexApp && row.engine === engine);
  assert.ok(lane, `a raw fixture lane on ${engine}`);
  return lane;
};

const temps: string[] = [];
const tempDir = (): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "eval-fixture-lanes-")));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const evalCase: EvalCase = {
  id: "mini-golf",
  number: 3,
  label: "Mini golf",
  brief: "Make a one-hole mini golf game.",
  mode: CaseMode.Build,
  exposure: CaseExposure.None,
  exposureReason: null,
  visibility: CaseVisibility.Public,
  acceptance: [],
  followUps: [],
  deadlineMin: 90,
  version: "0123456789ab",
  checklistVersion: "0123456789ab",
  startFrom: null,
};

function request(lane: LaneRegistryRow, root: string): LaneRunRequest {
  const runId = `20261001T120000-${lane.id}-mini-golf-r1`;
  return {
    runId,
    campaignId: "20261001T120000-fixture",
    lane,
    evalCase,
    rep: 1,
    workRoot: path.join(root, "evals", "work", runId),
    laneRoot: path.join(root, "evals", "work", runId),
    homes: { claude: path.join(root, "evals", "homes", "claude"), codex: path.join(root, "evals", "homes", "codex") },
    appBuild: null,
    deadlineMs: 60_000,
    graceMs: 5_000,
    suffix: "You have about 1 minutes.",
    deliverable: null,
    answerPolicy: ANSWER_POLICY,
    maxAnswers: 3,
    live: true,
    interleaveSeed: "seed",
    coRunLane: null,
    templateDigest: null,
    startDir: null,
  };
}

/** The real supervisor and the stubs; the operator's own skills and names are an empty folder's. */
function stubDeps(root: string): RawLaneDeps {
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  return {
    supervisor: SYSTEM_SUPERVISOR,
    resolveCli: fixtureStubResolver(),
    hostSkillsDir: path.join(root, "host-skills"),
    operatorNames: async () => ({ skills: new Set(), agents: new Set() }),
    permissionMode: PermissionMode.Auto,
    readQuota: null,
    parentEnv: { PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter) },
    home,
    node: process.execPath,
    lookAtPageScript: async () => "/installed/look-at-page.ts",
  };
}

describe("fixture lanes", () => {
  it("cover lanes A to D: both Genex engines and both raw CLIs", () => {
    const shapes = fixtureLanes.map((lane) => `${lane.agent}/${lane.engine}`).sort();
    assert.deepEqual(shapes, [
      `${EvalAgent.ClaudeCli}/${EngineId.ClaudeCode}`,
      `${EvalAgent.CodexCli}/${EngineId.Codex}`,
      `${EvalAgent.GenexApp}/${EngineId.ClaudeCode}`,
      `${EvalAgent.GenexApp}/${EngineId.Codex}`,
    ]);
  });

  it("ask the app's fixture engines for a model those engines list", async () => {
    const listed = new Map<string, string[]>();
    for (const engine of fixtureEngines())
      listed.set(
        engine.id,
        (await engine.models()).map((model) => model.id),
      );
    for (const lane of fixtureLanes.filter((row) => row.agent === EvalAgent.GenexApp))
      assert.ok(listed.get(lane.engine)?.includes(lane.model), `${lane.id} asks for ${lane.model}`);
  });

  it("resolve a raw fixture lane to its stub and every other lane to the machine's CLI", async () => {
    const machine = async () => ({ path: "/machine/cli", version: "9.9.9" });
    for (const engine of [EngineId.ClaudeCode, EngineId.Codex] as const) {
      const stub = await laneCliResolver(rawFixture(engine), machine)(engine);
      assert.equal(stub.path, fixtureStubPath(engine));
      assert.match(stub.version ?? "", /^\d+\.\d+\.\d+-fixture$/);
    }
    const real = registry.lanes.find((lane) => !lane.fixture && lane.agent === EvalAgent.ClaudeCli);
    assert.ok(real);
    assert.equal((await laneCliResolver(real, machine)(EngineId.ClaudeCode)).path, "/machine/cli");
  });

  it("refuse a stub that is not there as a missing CLI", async () => {
    const root = tempDir();
    await assert.rejects(fixtureStubResolver(root)(EngineId.Codex));
  });

  for (const engine of [EngineId.ClaudeCode, EngineId.Codex] as const) {
    it(`replay a recorded ${engine} build through the real raw lane runner, clean and timed`, async () => {
      const root = tempDir();
      const lane = rawFixture(engine);
      const req = request(lane, root);
      const result = await runRawLane(req, stubDeps(root));
      assert.equal(result.harnessFailure, null);
      assert.equal(result.endedHow, EndedHow.AgentFinished);
      assert.equal(result.contaminationClean, true);
      assert.equal(result.exitCode, 0);
      assert.equal(result.cliVersion, (await fixtureStubResolver()(engine)).version);
      for (const file of ["index.html", "main.js"])
        assert.ok(fs.statSync(path.join(result.artifacts.projectDir, file)).isFile(), file);
      const records = readStreamRecords(fs.readFileSync(result.artifacts.streamPath ?? "", "utf8"));
      assert.ok(records.length >= 6, `${records.length} lines`);
      const times = records.map((record) => record.receivedAt);
      assert.deepEqual(
        times,
        [...times].sort((a, b) => a - b),
        "received in order",
      );
      assert.ok((times.at(-1) ?? 0) - (times[0] ?? 0) >= 500, "the recorded gaps are replayed, not collapsed");
      const collected = await collectRun({ lane, result, snapshot: null, prices: readPriceTable(repo) });
      assert.equal(collected.metrics.harnessFailure, null);
      assert.equal(collected.observation.provenance.servedMain, lane.model);
      assert.ok(collected.transcriptSha256, "the stub left its CLI's transcript in the eval home");
      assert.notEqual(collected.metrics.tokens.coverage, Coverage.Unmeasured, "tokens measured");
      assert.notEqual(collected.metrics.calls.coverage, Coverage.Unmeasured, "tool calls measured");
    });
  }

  it("run through `campaign run`'s machine runner on the stubs, reading no provider's quota", async () => {
    const root = tempDir();
    const layout = evalsLayout(path.join(root, "evals"));
    const quotaReads: string[] = [];
    const runLane = systemLaneRunner(
      layout,
      async (engine) => {
        quotaReads.push(engine);
        return null;
      },
      path.join(root, "home"),
    );
    for (const engine of [EngineId.ClaudeCode, EngineId.Codex] as const) {
      const result = await runLane(request(rawFixture(engine), root));
      assert.equal(result.harnessFailure, null, engine);
      assert.equal(result.cliVersion, (await fixtureStubResolver()(engine)).version, engine);
    }
    assert.deepEqual(quotaReads, []);
  });
});
