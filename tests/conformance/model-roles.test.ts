/**
 * Three jobs, three picks — the policy that decides who plans, builds and judges, and the
 * explicit roles the composer's panel sends over it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeRoles,
  isDelegated,
  modelsFor,
  normalizeRoles,
  resolveRoles,
  withRoles,
  DELEGATED_ENGINES,
  FABLE,
  ROLES,
  SOL,
} from "../../src/harness-seed/loop/model-roles.ts";

describe("model roles", () => {
  it("a local pick is one model for every job", () => {
    assert.deepEqual(resolveRoles("ollama", "qwen3.8:27b-mlx"), {
      planner: "qwen3.8:27b-mlx",
      builder: "qwen3.8:27b-mlx",
      judge: "qwen3.8:27b-mlx",
    });
    assert.equal(describeRoles("ollama", "qwen3.8:27b-mlx"), "");
  });

  it("an explicit version is used for every unset role", () => {
    assert.deepEqual(resolveRoles("claude-code", FABLE), { planner: FABLE, builder: FABLE, judge: FABLE });
    assert.equal(describeRoles("claude-code", FABLE), "claude-fable-5-1 plans, builds and judges");
  });

  it("plain Claude Code keeps its own default for all roles", () => {
    assert.deepEqual(resolveRoles("claude-code", undefined), {
      planner: undefined,
      builder: undefined,
      judge: undefined,
    });
    assert.deepEqual(resolveRoles("claude-code", "default"), {
      planner: undefined,
      builder: undefined,
      judge: undefined,
    });
    assert.equal(describeRoles("claude-code", "default"), "default plans, builds and judges");
  });

  it("an explicit Opus or Sonnet pick is that model everywhere", () => {
    assert.deepEqual(resolveRoles("claude-code", "opus"), { planner: "opus", builder: "opus", judge: "opus" });
    assert.equal(describeRoles("claude-code", "sonnet"), "sonnet plans, builds and judges");
  });

  it("a run spec is stamped once: builders' model, critics' model, and the roles record", () => {
    const stamped = withRoles({ runId: "r1", engine: "claude-code", model: FABLE, budgets: { wallClockMs: 1 } });
    assert.equal(stamped.model, FABLE, "every build site reads run.model — it must be the builders' model");
    assert.equal(stamped.judgeEngine, "claude-code");
    assert.equal(stamped.judgeModel, FABLE);
    assert.deepEqual(stamped.roles, { planner: FABLE, builder: FABLE, judge: FABLE });
    assert.equal(stamped.rolesApplied, true);
    // Resolving again from the builders' model would demote the planner to Opus.
    assert.equal(withRoles(stamped).roles.planner, FABLE);
    assert.equal(withRoles(stamped).model, FABLE);
  });

  it("a default Claude Code pick leaves the builders and critics on the engine default", () => {
    const stamped = withRoles({ runId: "r2", engine: "claude-code", budgets: { wallClockMs: 1 } });
    assert.equal("model" in stamped, false);
    assert.equal("judgeModel" in stamped, false);
    assert.equal(stamped.roles.planner, undefined);
  });

  it("a critic chosen on another engine keeps that engine's own default", () => {
    const stamped = withRoles({
      runId: "r3",
      engine: "claude-code",
      model: FABLE,
      judgeEngine: "ollama",
      budgets: { wallClockMs: 1 },
    });
    assert.equal(stamped.judgeEngine, "ollama");
    assert.equal("judgeModel" in stamped, false);
  });

  it("the composer's roles panel wins over the preset: orchestrator, workers and judges each their own model", () => {
    const stamped = withRoles({
      runId: "r4",
      engine: "claude-code",
      model: "opus",
      roles: { planner: FABLE, builder: "sonnet", judge: "opus" },
      budgets: { wallClockMs: 1 },
    });
    assert.deepEqual(stamped.roles, { planner: FABLE, builder: "sonnet", judge: "opus" });
    assert.equal(
      stamped.model,
      "sonnet",
      "the builders build on the workers' pick, not on the model the interview ran on",
    );
    assert.equal(stamped.judgeModel, "opus");
    assert.equal(
      describeRoles("claude-code", "opus", stamped.roles),
      "claude-fable-5-1 plans · sonnet builds · opus judges",
    );
    // Applying twice changes nothing.
    assert.deepEqual(withRoles(stamped), stamped);
  });

  it('"default" in a role slot is the engine\'s own default, and a missing slot takes the preset', () => {
    assert.deepEqual(normalizeRoles("claude-code", { planner: "default", builder: "opus" }), {
      planner: undefined,
      builder: "opus",
      judge: undefined,
    });
    assert.equal(normalizeRoles("claude-code", {}), null);
    assert.equal(normalizeRoles("claude-code", null), null);
    const stamped = withRoles({
      runId: "r5",
      engine: "claude-code",
      roles: { builder: "sonnet" },
      budgets: { wallClockMs: 1 },
    });
    assert.equal(stamped.model, "sonnet");
    assert.equal(stamped.roles.planner, undefined, "an unset orchestrator slot uses the CLI default");
    assert.equal("judgeModel" in stamped, false);
  });

  it("a Codex pick means that model everywhere — there is no price cliff to split around", () => {
    assert.deepEqual(resolveRoles("codex", SOL), { planner: SOL, builder: SOL, judge: SOL });
    assert.equal(describeRoles("codex", SOL), "gpt-5.6-sol plans, builds and judges");
    const stamped = withRoles({ runId: "c1", engine: "codex", model: SOL, budgets: { wallClockMs: 1 } });
    assert.equal(stamped.model, SOL);
    assert.equal(stamped.judgeEngine, "codex");
    assert.equal(stamped.judgeModel, SOL);
  });

  it("Codex's default pick leaves every job on whatever the CLI is set to", () => {
    assert.deepEqual(resolveRoles("codex", undefined), { planner: undefined, builder: undefined, judge: undefined });
    assert.equal(describeRoles("codex", "default"), "default plans, builds and judges");
    const stamped = withRoles({ runId: "c2", engine: "codex", budgets: { wallClockMs: 1 } });
    assert.equal("model" in stamped, false);
    assert.equal("judgeModel" in stamped, false);
  });

  it("the composer can split the three jobs across Codex models too", () => {
    const stamped = withRoles({
      runId: "c3",
      engine: "codex",
      model: SOL,
      roles: { planner: SOL, builder: "gpt-5.6-terra", judge: SOL },
      budgets: { wallClockMs: 1 },
    });
    assert.equal(stamped.model, "gpt-5.6-terra");
    assert.equal(stamped.judgeModel, SOL);
    assert.equal(
      describeRoles("codex", SOL, stamped.roles),
      "gpt-5.6-sol plans · gpt-5.6-terra builds · gpt-5.6-sol judges",
    );
  });

  it("both subscriptions have roles; a local engine has none", () => {
    assert.deepEqual([...DELEGATED_ENGINES], ["claude-code", "codex"]);
    assert.equal(isDelegated("codex"), true);
    assert.equal(isDelegated("ollama"), false);
    assert.equal(describeRoles("ollama", "qwen3.8:27b-mlx"), "");
    assert.deepEqual(modelsFor("ollama"), []);
    assert.deepEqual(modelsFor("codex"), [], "legacy exports do not claim model availability");
  });

  it("the roles panel lists the three jobs in order", () => {
    assert.deepEqual(
      ROLES.map((r) => r.key),
      ["planner", "builder", "judge"],
    );
  });
});

/**
 * Two subscriptions in one run: the composer may send the
 * workers and/or the judges to the other signed-in engine. The record says so in `engines`,
 * the stamped run in `builderEngine`/`judgeEngine`, and every site that starts a job asks
 * `roleEngine`/`modelOn` so a model id never reaches an engine that does not know it. A run
 * with nothing crossed must read exactly as it did before this existed.
 */
import { engineLabel, modelOn, plannerModel, roleEngine } from "../../src/harness-seed/loop/model-roles.ts";

describe("roles across two subscriptions", () => {
  it("keeps a crossed worker or judge, and never a crossed orchestrator, a same-engine cross, or an engine nobody can hire", () => {
    assert.deepEqual(
      normalizeRoles("claude-code", {
        planner: "opus",
        builder: "gpt-6-astra",
        judge: "gpt-6-astra",
        engines: { builder: "codex", judge: "codex" },
      }),
      {
        planner: "opus",
        builder: "gpt-6-astra",
        judge: "gpt-6-astra",
        engines: { builder: "codex", judge: "codex" },
      },
    );
    // The orchestrator is the run's engine: an `engines.planner` is noise, not a pick.
    assert.deepEqual(normalizeRoles("claude-code", { planner: "opus", engines: { planner: "codex" } }), {
      planner: "opus",
      builder: undefined,
      judge: undefined,
    });
    // Crossing to the engine the run is already on is not a cross.
    assert.deepEqual(normalizeRoles("codex", { builder: SOL, engines: { builder: "codex" } }), {
      planner: undefined,
      builder: SOL,
      judge: undefined,
    });
    // Workers never cross to a completion-only local engine: the director hires every worker as a
    // session, and that engine holds none.
    assert.deepEqual(normalizeRoles("claude-code", { builder: "opus", engines: { builder: "ollama" } }), {
      planner: undefined,
      builder: "opus",
      judge: undefined,
    });
    // Its reviewers may join a session run: every judge but the playtester asks engine.complete.
    assert.deepEqual(normalizeRoles("claude-code", { judge: "vl", engines: { judge: "ollama" } }), {
      planner: undefined,
      builder: undefined,
      judge: "vl",
      engines: { judge: "ollama" },
    });
    // And its main agent may hand its workers and reviewers to a session engine (the classic loop).
    assert.deepEqual(normalizeRoles("ollama", { builder: "opus", engines: { builder: "claude-code" } }), {
      planner: undefined,
      builder: "opus",
      judge: undefined,
      engines: { builder: "claude-code" },
    });
    // An engine nobody can hire is still nobody's to cross to.
    assert.deepEqual(normalizeRoles("ollama", { judge: "x", engines: { judge: "gemini-cli" } }), {
      planner: undefined,
      builder: undefined,
      judge: "x",
    });
    // A crossed slot with no model named is that engine's own default.
    assert.deepEqual(normalizeRoles("claude-code", { engines: { judge: "codex" } }), {
      planner: undefined,
      builder: undefined,
      judge: undefined,
      engines: { judge: "codex" },
    });
  });

  it("stamps a run whose reviewers or workers sit on the other side of a completion-only local engine", () => {
    const reviewedLocally = withRoles({
      runId: "lr1",
      engine: "claude-code",
      model: "opus",
      roles: { planner: "opus", builder: "opus", judge: "vl", engines: { judge: "ollama" } },
    });
    assert.equal(reviewedLocally.judgeEngine, "ollama");
    assert.equal(reviewedLocally.judgeModel, "vl");
    assert.equal(reviewedLocally.builderEngine, undefined, "the workers stay on the run's own engine");
    assert.equal(modelOn(reviewedLocally, "claude-code"), "opus");
    const builtElsewhere = withRoles({
      runId: "lr2",
      engine: "ollama",
      model: "qwen",
      roles: { planner: "qwen", builder: "opus", judge: "vl", engines: { builder: "claude-code" } },
    });
    assert.equal(builtElsewhere.builderEngine, "claude-code");
    assert.equal(builtElsewhere.model, "opus");
    assert.equal(builtElsewhere.judgeEngine, "ollama");
    assert.equal(builtElsewhere.judgeModel, "vl");
    assert.equal(modelOn(builtElsewhere, "ollama"), "qwen", "the main agent's own engine hears its own model");
  });

  it("stamps the run with the workers' and the judges' engines, and each slot's model stays that engine's", () => {
    const stamped = withRoles({
      runId: "x1",
      engine: "claude-code",
      model: "opus",
      roles: {
        planner: "opus",
        builder: "gpt-6-astra",
        judge: "gpt-6-astra",
        engines: { builder: "codex", judge: "codex" },
      },
      budgets: { wallClockMs: 1 },
    });
    assert.equal(stamped.engine, "claude-code", "the orchestrator's engine is the run's");
    assert.equal(stamped.builderEngine, "codex");
    assert.equal(
      stamped.model,
      "gpt-6-astra",
      "every build site reads run.model — it is the workers' model, on the workers' engine",
    );
    assert.equal(stamped.judgeEngine, "codex");
    assert.equal(stamped.judgeModel, "gpt-6-astra");
    assert.equal(roleEngine(stamped, "planner"), "claude-code");
    assert.equal(roleEngine(stamped, "builder"), "codex");
    assert.equal(roleEngine(stamped, "judge"), "codex");
    assert.equal(plannerModel(stamped), "opus");
    assert.equal(modelOn(stamped, "claude-code"), "opus", "a Claude session gets a Claude model");
    assert.equal(modelOn(stamped, "codex"), "gpt-6-astra", "a Codex session gets a Codex model");
    assert.equal(modelOn(stamped, "ollama"), undefined, "an engine nobody picked for gets its own default");
    assert.equal(
      describeRoles("claude-code", "opus", stamped.roles),
      "opus plans · gpt-6-astra on Codex builds & judges",
    );
    // Applying twice changes nothing.
    assert.deepEqual(withRoles(stamped), stamped);
  });

  it("the other way round: an Astra orchestrator on Codex with Opus workers and Astra judges", () => {
    const stamped = withRoles({
      runId: "x2",
      engine: "codex",
      model: "gpt-6-astra",
      roles: { planner: "gpt-6-astra", builder: "opus", judge: "gpt-6-astra", engines: { builder: "claude-code" } },
      budgets: { wallClockMs: 1 },
    });
    assert.equal(stamped.builderEngine, "claude-code");
    assert.equal(stamped.model, "opus");
    assert.equal(stamped.judgeEngine, "codex", "the judges stayed home");
    assert.equal(stamped.judgeModel, "gpt-6-astra");
    assert.equal(plannerModel(stamped), "gpt-6-astra");
    assert.equal(modelOn(stamped, "codex"), "gpt-6-astra");
    assert.equal(modelOn(stamped, "claude-code"), "opus");
    assert.equal(
      describeRoles("codex", "gpt-6-astra", stamped.roles),
      "gpt-6-astra plans · opus on Claude Code builds · gpt-6-astra judges",
    );
    assert.equal(engineLabel("claude-code"), "Claude Code");
    assert.equal(engineLabel("codex"), "Codex");
  });

  it("a crossed slot with no model is that engine's own default", () => {
    const stamped = withRoles({
      runId: "x3",
      engine: "claude-code",
      model: FABLE,
      roles: { planner: FABLE, engines: { builder: "codex" } },
      budgets: { wallClockMs: 1 },
    });
    assert.equal(stamped.builderEngine, "codex");
    assert.equal("model" in stamped, false, "the workers run on whatever Codex is set to");
    assert.equal(stamped.judgeEngine, "claude-code");
    assert.equal("judgeModel" in stamped, false);
    assert.equal(modelOn(stamped, "codex"), undefined);
    assert.equal(
      modelOn(stamped, "claude-code"),
      FABLE,
      "the orchestrator's model is the only Claude model on this run",
    );
  });

  it("the composer's crossed judge wins over the judge engine the spec arrived with", () => {
    const stamped = withRoles({
      runId: "x4",
      engine: "claude-code",
      judgeEngine: "ollama",
      roles: { judge: "gpt-6-astra", engines: { judge: "codex" } },
      budgets: { wallClockMs: 1 },
    });
    assert.equal(stamped.judgeEngine, "codex");
    assert.equal(stamped.judgeModel, "gpt-6-astra");
  });

  it("a run on one subscription carries nothing new", () => {
    const before = {
      runId: "x5",
      engine: "claude-code",
      model: FABLE,
      roles: { planner: FABLE, builder: "sonnet", judge: "opus" },
      budgets: { wallClockMs: 1 },
    };
    const stamped = withRoles(before);
    assert.equal("builderEngine" in stamped, false);
    assert.deepEqual(
      stamped.roles,
      { planner: FABLE, builder: "sonnet", judge: "opus" },
      "no engines key on an uncrossed record",
    );
    assert.equal(roleEngine(stamped, "builder"), "claude-code");
    assert.equal(modelOn(stamped, "claude-code"), "sonnet", "the builders' pick, as every build site read it before");
    assert.equal(plannerModel(stamped), FABLE);
    // A spec no policy stamped yet: its one model is everyone's, as before.
    assert.equal(plannerModel({ engine: "codex", model: SOL }), SOL);
    assert.equal(modelOn({ engine: "codex", model: SOL }, "codex"), SOL);
  });
});
