import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runOptimization } from "../../src/harness-seed/loop/optimization.ts";
import { GameCandidates } from "../../src/substrate/game-candidate.ts";
import { SnapshotEngine } from "../../src/substrate/snapshots.ts";
import { createToolRegistry } from "../../src/harness-seed/tools/index.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { BuildTarget, GameStack } from "../../src/shared/game-project.ts";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "optimization-stage-")),
    live = path.join(root, "live");
  await mkdir(live);
  await writeFile(path.join(live, "index.html"), "baseline");
  const snapshots = new SnapshotEngine([{ name: "game", dir: live }]);
  await snapshots.init();
  const baseline = await snapshots.snapshot({
    scope: "game",
    gameWorkspace: "game",
    reason: "verified",
    healthy: true,
  });
  const candidates = new GameCandidates(snapshots, path.join(root, "scratch"));
  const events: any[] = [],
    calls: string[] = [];
  const journal: any = { phase: "verdict" };
  const ctx = {
    workspace: path.resolve("src/harness-seed"),
    cancelled: false,
    threadId: "t",
    notify() {},
    setStatus() {},
    async call(method: string, p: any = {}): Promise<any> {
      calls.push(method);
      switch (method) {
        case "artifact.write":
          return true;
        case "events.append":
          events.push(...structuredClone(p.batch));
          return true;
        case "run.artifact": {
          const file = path.join(root, p.name);
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, Buffer.from(p.base64, "base64"));
          return file;
        }
        case "optimization.open":
          return candidates.open(p.project, p.runId, p.baselineSnapshotId, baseline.git.game!);
        case "optimization.freeze":
          return candidates.freeze(p.candidateId);
        case "optimization.promote":
          return candidates.promote(p.candidateId, p.expectedLive, p.verifiedCandidate, p.resultArtifact);
        case "optimization.close":
          return candidates.close(p.candidateId);
        case "optimization.reconcile":
          return candidates.reconcile(p.project, p.baseline, p.candidate);
        case "preview.acquire":
          return { handle: "h" };
        case "preview.call":
        case "preview.load":
        case "preview.release":
          return true;
        case "game.write": {
          const file = await candidates.file(p.candidateId, p.project, p.file, true);
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, p.contents);
          return { bytes: p.contents.length };
        }
        default:
          throw new Error(`unexpected method ${method}`);
      }
    },
  };
  const evidence = {
    ok: true,
    shots: [{ camera: "default", path: "test.jpg", base64: "cGl4ZWxz" }],
    registeredDemos: [],
    state: { score: 1 },
  };
  const services: any = {
    minimumMs: 0,
    minimumWorkerMs: 0,
    postBuildReserveMs: 0,
    evidence: async () => structuredClone(evidence),
    checks: async () => [{ id: "main/works", pass: true }],
    preserve: async () => ({ status: "preserved", reasons: [], summary: "Reused redundant work" }),
    sample: async (revision: any, scenario: any) => {
      const metric = (value: number) => ({ value, unit: "test", reason: null, provenance: "test" });
      return {
        schemaVersion: 1,
        backend: "webgl",
        renderer: "WebGLRenderer",
        version: "0.185.1",
        scope: "world",
        scenarioId: scenario.id,
        configuration: { width: 960, height: 600 },
        revision,
        metrics: {
          fps: metric(60),
          frameMs: metric(16),
          drawCalls: metric(revision.commit === baseline.git.game ? 100 : 50),
          triangles: metric(1000),
        },
      };
    },
    worker: async ({ candidate, brief }: any) => {
      assert.match(brief, /Final optimization specialist/);
      assert.match(brief, /"drawCalls"/);
      await writeFile(path.join(candidate.root, "index.html"), "candidate");
    },
  };
  const options: any = {
    threadId: "t",
    run: { runId: "run_test", project: "game", goal: "Same game faster", budgets: { wallClockMs: 6_000_000 } },
    journal,
    baselineSnapshot: baseline,
    baselineVerified: true,
    baselineEvidence: evidence,
    requiredChecks: [{ id: "main/works", pass: true }],
    deadline: Date.now() + 600_000,
    quality: async () => true,
    services,
  };
  return { ctx, options, live, root, calls, events, journal, services, candidates };
}
it("an invisible measured optimization is kept only after fresh quality and durable validation", async () => {
  const f = await fixture();
  let quality = 0;
  f.options.quality = async () => {
    quality++;
    return true;
  };
  const r = await runOptimization(f.ctx, f.options);
  assert.equal(r.outcome, "improved");
  assert.equal(r.candidateAdopted, true);
  assert.equal(quality, 1);
  assert.equal(await readFile(path.join(f.live, "index.html"), "utf8"), "candidate");
  assert.equal(f.events.at(-1).payload.outcome, "improved");
  assert.equal(f.journal.optimization.adoptionIntent.verifiedCandidate.tree, r.retainedRevision.tree);
  const before = f.calls.filter((c) => c === "optimization.open").length;
  await runOptimization(f.ctx, f.options);
  assert.equal(f.calls.filter((c) => c === "optimization.open").length, before, "completed stage never rebuilds");
});
it("no-op, missing previously passing check, failed quality and preservation loss keep B", async () => {
  for (const scenario of ["noop", "check", "quality", "preserve", "failure", "cancel"]) {
    const f = await fixture();
    if (scenario === "noop") f.services.worker = async () => {};
    if (scenario === "check") {
      let n = 0;
      f.services.checks = async () => [{ id: "main/works", pass: ++n === 1 ? true : null }];
    }
    if (scenario === "quality") f.options.quality = async () => false;
    if (scenario === "preserve") f.services.preserve = async () => ({ status: "regressed", reasons: ["lost effect"] });
    if (scenario === "failure")
      f.services.worker = async () => {
        throw new Error("provider failed");
      };
    if (scenario === "cancel")
      f.services.worker = async () => {
        f.ctx.cancelled = true;
      };
    const r = await runOptimization(f.ctx, f.options);
    assert.notEqual(r.outcome, "improved", scenario);
    assert.equal(r.candidateAdopted, false, scenario);
    assert.equal(await readFile(path.join(f.live, "index.html"), "utf8"), "baseline", scenario);
    assert.ok(!f.calls.includes("optimization.promote"), scenario);
  }
});
it("live edits during validation survive; no reset/clean is a fallback", async () => {
  const f = await fixture();
  f.options.quality = async () => {
    await writeFile(path.join(f.live, "index.html"), "human edit");
    return true;
  };
  const r = await runOptimization(f.ctx, f.options);
  assert.equal(r.reasonCode, "baseline_changed");
  assert.equal(await readFile(path.join(f.live, "index.html"), "utf8"), "human edit");
});
it("an unverified baseline or exhausted allowance skips before any candidate or worker", async () => {
  for (const expired of [false, true]) {
    const f = await fixture();
    if (expired) f.options.deadline = Date.now() - 1;
    else f.options.baselineVerified = false;
    const r = await runOptimization(f.ctx, f.options);
    assert.equal(r.outcome, "skipped");
    assert.ok(!f.calls.includes("optimization.open"));
  }
});
it("stage-only direct registry injects candidate authority and excludes own-source/command tools", async () => {
  const seen: any[] = [];
  const ctx = {
    workspace: path.resolve("src/harness-seed"),
    call: async (method: string, p: any) => {
      seen.push({ method, p });
      return "file";
    },
  };
  const registry = await createToolRegistry(ctx as never, { candidateId: "trusted", project: "game" });
  assert.deepEqual(registry.names().sort(), ["check_game", "list_files", "read_file", "write_file"]);
  await registry.execute({ name: "read_file", arguments: { file: "index.html", candidateId: "forged" } }, ctx as never);
  assert.equal(seen[0].p.candidateId, "trusted");
  assert.equal((await registry.execute({ name: "run_command", arguments: {} }, ctx as never)).ok, false);
});

it("a counter benefit cannot hide a timing regression with the counter observer disabled", async () => {
  const f = await fixture();
  const sample = f.services.sample;
  f.services.sample = async (revision: any, scenario: any, counters: boolean) => {
    const s = await sample(revision, scenario);
    if (counters === false) {
      s.configuration.counters = false;
      s.metrics.frameMs.value = s.metrics.drawCalls.value === 50 ? 32 : 16;
      s.metrics.drawCalls.value = null;
      s.metrics.triangles.value = null;
    }
    return s;
  };
  const result = await runOptimization(f.ctx, f.options);
  assert.equal(result.outcome, "no_improvement");
  assert.equal(result.candidateAdopted, false);
  assert.equal(await readFile(path.join(f.live, "index.html"), "utf8"), "baseline");
});

it("graceful finish skips an unstarted optimization worker but lets an in-flight attempt validate", async () => {
  for (const boundary of ["before_stage", "after_diagnostics", "during_worker"]) {
    const f = await fixture();
    let finishing = boundary === "before_stage",
      workers = 0;
    Object.assign(f.ctx, { runInbox: { finishing: async () => finishing } });
    const sample = f.services.sample,
      worker = f.services.worker;
    f.services.sample = async (...args: any[]) => {
      const result = await sample(...args);
      if (boundary === "after_diagnostics") finishing = true;
      return result;
    };
    f.services.worker = async (args: any) => {
      workers++;
      finishing = true;
      await worker(args);
    };
    const result = await runOptimization(f.ctx, f.options);
    assert.equal(workers, boundary === "during_worker" ? 1 : 0, boundary);
    assert.equal(result.outcome, boundary === "during_worker" ? "improved" : "skipped", boundary);
    if (boundary !== "during_worker") assert.equal(result.reasonCode, "finish_requested");
    if (boundary === "before_stage") assert.ok(!f.calls.includes("optimization.open"));
    assert.equal(
      await readFile(path.join(f.live, "index.html"), "utf8"),
      boundary === "during_worker" ? "candidate" : "baseline",
    );
  }
});

it("the built-in sampler prepares the scenario, arms the profiler and ends the session it opened", async () => {
  for (const failure of ["begin", "read"]) {
    const f = await fixture();
    delete f.services.sample;
    const steps: string[] = [];
    const call = f.ctx.call.bind(f.ctx);
    f.ctx.call = async (method: string, p: any = {}) => {
      if (method === "preview.call") steps.push(p.arg === undefined ? p.method : `${p.method}:${p.arg}`);
      if (method !== "preview.profile") return call(method, p);
      f.calls.push(method);
      steps.push(`profile:${p.action}`);
      if (p.action === "begin")
        return failure === "begin" ? { sessionId: null, reason: "renderer is not initialized" } : { sessionId: "s1" };
      if (p.action === "read") return { state: "unavailable", reason: "context lost" };
      return true;
    };
    const r = await runOptimization(f.ctx, f.options);
    assert.equal(r.outcome, "skipped", failure);
    assert.equal(r.reasonCode, failure === "begin" ? "renderer_not_ready" : "capability_missing", failure);
    const prepared = ["seed:1234", "pause", "step:960", "debugCamera:default"];
    const armed = ["pause", ...prepared, "start", ...prepared, "profile:begin"];
    const opened = ["profile:start", "profile:read", "profile:end"];
    assert.deepEqual(steps, failure === "begin" ? armed : [...armed, ...opened], failure);
    assert.ok(!f.calls.includes("optimization.promote"), failure);
    assert.equal(await readFile(path.join(f.live, "index.html"), "utf8"), "baseline", failure);
  }
});

it("the stage's preview names the build it judges: a Mac-only C++ · raylib game's is its judging-only web build", async () => {
  // The host refuses a raylib game's preview on a lease that names no target
  // (harness-predates-native), so an untargeted acquire ended every raylib stage at its first look.
  // A native lease cannot profile (the host refuses a candidate load on one): the stage profiles
  // the game's web build in a browser window.
  const f = await fixture();
  const acquired: Array<Record<string, unknown>> = [];
  const call = f.ctx.call.bind(f.ctx);
  f.ctx.call = async (method: string, p: any = {}) => {
    if (method === "game.list")
      return [{ name: "game", destinations: { stack: GameStack.RaylibCpp, targets: [BuildTarget.Mac] } }];
    if (method === "preview.capacity") return { max: 4, inUse: 0, host: StudioPlatform.Mac, native: { gameBox: true } };
    if (method === "preview.acquire") acquired.push(p);
    return call(method, p);
  };
  await runOptimization(f.ctx, f.options);
  assert.deepEqual(
    acquired.map((p) => [p.target, p.label, p.purpose]),
    [[BuildTarget.Web, "optimization:run_test", "optimization"]],
  );
});
