import assert from "node:assert/strict";
import { test } from "node:test";
import { PlanReviewController } from "../../src/main/plan-review.ts";
import type { PlanReview, ComposerSendOptions } from "../../src/shared/composer.ts";
import { supportedPreferences } from "../../src/shared/model-preferences.ts";
import { normalizeClaudeUsage, normalizeCodexUsage } from "../../src/shared/provider-usage.ts";
import { normalizeRoles, roleEffort } from "../../src/harness-seed/loop/model-roles.ts";

function fixture() {
  const records = new Map<string, PlanReview>(),
    sent: Array<{ text: string; options: ComposerSendOptions }> = [];
  const host = {
    load: async (t: string) => records.get(t) ?? null,
    save: async (t: string, r: PlanReview) => {
      records.set(t, structuredClone(r));
    },
    generate: async () => "1. Build the scene.\n2. Verify controls.",
    dispatch: async (text: string, options: ComposerSendOptions) => {
      sent.push({ text, options });
    },
  };
  return { records, sent, host, controller: new PlanReviewController(host) };
}
for (const loop of [false, true])
  test(`manual plan approval gates ${loop ? "Loop" : "Auto"}, persists across restart and dispatches once`, async (t) => {
    const f = fixture();
    await f.controller.request("chat", "Make a game", {
      reviewPlan: true,
      ...(loop
        ? {
            autopilot: { hours: 0.25, roles: { planner: "p", builder: "w", judge: "j", efforts: { builder: "high" } } },
          }
        : {}),
      preferences: { fast: true },
      engine: "codex",
    });
    const pending = f.records.get("chat")!;
    assert.equal(pending.state, "waiting");
    assert.equal(f.sent.length, 0);
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    t.mock.timers.tick(24 * 60 * 60 * 1000);
    const restored = new PlanReviewController(f.host);
    assert.equal(f.records.get("chat")!.state, "waiting");
    assert.equal(f.sent.length, 0);
    assert.equal(await restored.answer("chat", "stale-id", true), false);
    const answers = await Promise.all([
      restored.answer("chat", pending.id, true),
      restored.answer("chat", pending.id, true),
    ]);
    assert.deepEqual(answers.sort(), [false, true]);
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0]!.text, /User-approved implementation plan/);
    assert.equal(f.sent[0]!.options.reviewPlan, false);
    assert.equal(f.sent[0]!.options.autopilot?.hours, loop ? 0.25 : undefined);
    assert.deepEqual(f.sent[0]!.options.preferences, { fast: true });
    assert.equal(f.records.get("chat")!.state, "approved");
  });
test("messages revise a waiting plan, including the word go; cancellation invalidates approval", async () => {
  const f = fixture();
  await f.controller.request("chat", "Build a game", { reviewPlan: true });
  const old = f.records.get("chat")!;
  await f.controller.request("chat", "go, but add a river", {});
  const next = f.records.get("chat")!;
  assert.notEqual(next.id, old.id);
  assert.match(next.text, /Requested revision/);
  assert.equal(f.sent.length, 0);
  assert.equal(await f.controller.answer("chat", old.id, true), false);
  assert.equal(await f.controller.answer("chat", next.id, false), true);
  assert.equal(await f.controller.answer("chat", next.id, true), false);
  assert.equal(f.sent.length, 0);
});
test("plan revisions receive the actual prior plan, not just the original request", async () => {
  const f = fixture();
  await f.controller.request("chat", "Build a garden", { reviewPlan: true });
  const received: Array<PlanReview | null | undefined> = [];
  const host = {
    ...f.host,
    generate: async (_text: string, _options: ComposerSendOptions, _signal: AbortSignal, prior?: PlanReview | null) => {
      received.push(prior);
      return "Revised garden plan";
    },
  };
  await new PlanReviewController(host).request("chat", "Keep the layout and add blue flowers", {});
  assert.equal(received[0]?.plan, "1. Build the scene.\n2. Verify controls.");
  assert.equal(received[0]?.text, "Build a garden");
});
test("cancel interrupts planning and a late provider response cannot revive it", async () => {
  const f = fixture();
  let finish!: (text: string) => void, started!: (value?: unknown) => void;
  const ready = new Promise((r) => {
    started = r;
  });
  f.host.generate = async () => {
    started();
    return await new Promise<string>((r) => {
      finish = r;
    });
  };
  const pending = f.controller.request("chat", "Build", { reviewPlan: true });
  await ready;
  await f.controller.cancel("chat");
  finish("Late plan");
  await pending;
  assert.equal(f.records.get("chat")!.state, "cancelled");
  assert.equal(f.sent.length, 0);
});
test("failed dispatch preserves the reviewed plan for an explicit retry", async () => {
  const f = fixture();
  f.host.dispatch = async () => {
    throw new Error("Harness unavailable");
  };
  await f.controller.request("chat", "Build", { reviewPlan: true });
  const id = f.records.get("chat")!.id;
  await assert.rejects(f.controller.answer("chat", id, true), /Harness unavailable/);
  assert.equal(f.records.get("chat")!.state, "waiting");
  assert.match(f.records.get("chat")!.error!, /Harness unavailable/);
});
test("capabilities refuse unsupported Fast/context settings and retain exact role efforts", () => {
  // Saved by a build that still had the Auto-compact picker: every provider compacts on its own now.
  const savedWithWindow = { fast: false, contextWindow: 32000 };
  assert.deepEqual(supportedPreferences({ ...savedWithWindow, fast: true }, {}), {});
  assert.deepEqual(supportedPreferences(savedWithWindow, { supportsFast: true }), { fast: false });
  const roles = normalizeRoles("codex", {
    planner: "gpt-6-astra",
    builder: "opus",
    judge: "gpt-5.6-sol",
    engines: { builder: "claude-code" },
    efforts: { planner: "high", builder: "max", judge: "low" },
  });
  assert.equal(roleEffort({ roles, effort: "ultra" } as never, "builder"), "high", "a worker thinks at most hard");
  assert.equal(roleEffort({ roles, effort: "ultra" } as never, "planner"), "high");
  assert.equal(roleEffort({ effort: "ultra" }, "planner"), "ultra", "the lead thinks as hard as the user set");
  assert.equal(roleEffort({ roles } as never, "judge"), "low");
  assert.equal(roleEffort({ effort: "ultra" }, "builder"), undefined);
});
test("provider quota normalization preserves missing values and only exposes sanitized windows", () => {
  assert.equal(normalizeClaudeUsage({ rate_limits_available: false }), null);
  const usage = normalizeClaudeUsage(
    {
      subscription_type: "max",
      rate_limits_available: true,
      account: "private",
      rate_limits: {
        five_hour: { utilization: null, resets_at: null },
        seven_day: { utilization: 52, resets_at: "2026-09-23T16:00:00Z" },
        secret: { utilization: 1 },
      },
    },
    "2026-09-20T00:00:00Z",
  )!;
  assert.equal(usage.windows[0]!.percent, null);
  assert.equal(usage.windows[1]!.percent, 52);
  assert.equal(usage.windows.length, 2);
  assert.ok(!JSON.stringify(usage).includes("private"));
  const scoped = normalizeClaudeUsage({
    subscription_type: "max",
    rate_limits_available: true,
    rate_limits: {
      seven_day: { utilization: 28, resets_at: "2026-09-29T16:00:00Z" },
      model_scoped: [
        { display_name: "Fable", utilization: 100, resets_at: "2026-09-29T16:00:00Z" },
        { display_name: "", utilization: 5 },
      ],
    },
  })!;
  assert.deepEqual(
    scoped.windows.map((w) => [w.label, w.percent]),
    [
      ["Weekly · all models", 28],
      ["Weekly · Fable", 100],
    ],
  );
});
test("Codex plan limits come from the account read: windows by length, plan named, identifiers dropped", () => {
  assert.equal(normalizeCodexUsage(null), null);
  const usage = normalizeCodexUsage(
    {
      accountId: "secret-account",
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 76, windowDurationMins: 10080, resetsAt: 1790422525 },
        secondary: null,
        planType: "pro",
      },
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          primary: { usedPercent: 76, windowDurationMins: 10080, resetsAt: 1790422525 },
          secondary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1790210000 },
          planType: "pro",
        },
        "codex-spark": {
          limitId: "codex-spark",
          limitName: "Spark",
          primary: { usedPercent: 140, windowDurationMins: 10080, resetsAt: null },
          planType: "pro",
        },
      },
    },
    "2026-09-24T00:00:00Z",
  )!;
  assert.equal(usage.plan, "pro");
  assert.deepEqual(
    usage.windows.map((w) => [w.label, w.percent]),
    [
      ["5-hour limit", 12],
      ["Weekly limit", 76],
      ["Weekly limit · Spark", 100],
    ],
  );
  assert.equal(usage.windows[1]!.resetsAt, new Date(1790422525 * 1000).toISOString());
  assert.equal(usage.windows[2]!.resetsAt, undefined);
  assert.ok(!JSON.stringify(usage).includes("secret-account"));
  assert.deepEqual(
    normalizeCodexUsage({ rateLimits: { primary: { usedPercent: 3, windowDurationMins: 1440 } } })!.windows.map(
      (w) => w.label,
    ),
    ["1-day limit"],
  );
});

test("the real host stores approval before dispatch and keeps 15-minute Loop settings intact", async (t) => {
  const { StudioCore } = await import("../../src/main/studio-core.ts");
  const { fixtureEngines } = await import("../../src/main/dev/fixtures.ts");
  const { makeResources } = await import("../helpers/studio-rig.ts");
  const fs = await import("node:fs/promises"),
    path = await import("node:path"),
    os = await import("node:os");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-composer-review-"));
  const core = new StudioCore({
    paths: { userData: root, resources: await makeResources() },
    engines: fixtureEngines(),
    executionPolicy: { runBackgroundImprovement: false },
  });
  t.after(async () => {
    await core.stop();
    await fs.rm(root, { recursive: true, force: true });
  });
  await core.init();
  const thread = await core.createGameThread();
  const dispatched: unknown[] = [];
  t.mock.method(core.host, "dispatch", async (action: unknown) => {
    dispatched.push(action);
  });
  await core.sendUserMessage("Make a garden", {
    thread,
    engine: "codex",
    model: "fixture-v1",
    reviewPlan: true,
    autopilot: { hours: 0.25 },
    preferences: { fast: true },
  });
  const pending = (await core.store.getRecord(thread)).metadata?.planReview as PlanReview;
  assert.equal(pending.state, "waiting");
  assert.equal(dispatched.length, 0);
  await core.sendUserMessage("Make the flowers blue", { thread });
  assert.equal(dispatched.length, 0);
  assert.equal(await core.answerPlan(thread, pending.id, true), false);
  const revised = (await core.store.getRecord(thread)).metadata?.planReview as PlanReview;
  assert.equal(await core.answerPlan(thread, revised.id, true), true);
  const action = dispatched[0] as {
    autopilot: { hours: number; reviewPlan: boolean };
    preferences: { fast: boolean };
  };
  assert.equal(action.autopilot.hours, 0.25);
  assert.equal(action.autopilot.reviewPlan, false);
  assert.equal(action.preferences.fast, true);
});

test("each provider plans with current plugin capabilities without executable tools", async (t) => {
  const { StudioCore } = await import("../../src/main/studio-core.ts");
  const { fixtureEngines } = await import("../../src/main/dev/fixtures.ts");
  const { makeResources } = await import("../helpers/studio-rig.ts");
  const fs = await import("node:fs/promises"),
    path = await import("node:path"),
    os = await import("node:os");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-planning-tools-"));
  const core = new StudioCore({
    paths: { userData: root, resources: await makeResources() },
    engines: fixtureEngines(),
    executionPolicy: { runBackgroundImprovement: false },
  });
  t.after(async () => {
    await core.stop();
    // A late harness git write can still land in .git/info while the tree is removed (ENOTEMPTY).
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  await core.init();
  const thread = await core.createGameThread();
  const engines = core.engines.all();
  for (const engine of engines) {
    const requests: any[] = [];
    t.mock.method(engine as Required<typeof engine>, "complete", async (request: any) => {
      requests.push(request);
      return { message: { role: "assistant", content: "Plan with Genex assets" }, usage: {} };
    });
    await core.sendUserMessage("Plan with Genex assets", { thread, engine: engine.id, reviewPlan: true });
    assert.equal(requests.length, 1, engine.id);
    assert.deepEqual(requests[0].tools, []);
    assert.match(requests[0].messages[0].content, /genex__asset/);
    assert.match(requests[0].messages[0].content, /planning is tool-free/);
  }
  await core.plugins.setEnabled("genex", false);
  const engine = engines[0]!;
  let prompt = "";
  t.mock.method(engine as Required<typeof engine>, "complete", async (request: any) => {
    prompt = request.messages[0].content;
    return { message: { role: "assistant", content: "Updated plan" }, usage: {} };
  });
  await core.sendUserMessage("Revise after disabling Genex", { thread, engine: engine.id });
  assert.doesNotMatch(prompt.split("Original request:")[0]!, /genex__asset/);
  const events = await core.store.listEvents(thread);
  assert.ok(events.some((e) => e.data.type === "custom" && e.data.event_type === "planning_capabilities_applied"));
  assert.ok(
    !events.some((e) => e.data.type === "custom" && e.data.event_type === "tool_registry_applied"),
    "planning does not claim execution delivery",
  );
});

test("retrying an unavailable plan retains the request and changes the provider without duplicating the request", async () => {
  const f = fixture();
  let calls = 0;
  const host = {
    ...f.host,
    generate: async (text: string) => {
      if (++calls === 1) throw new Error("Model unavailable");
      assert.equal(text, "Make a football game");
      return "A football plan";
    },
  };
  const controller = new PlanReviewController(host);
  await controller.request("chat", "Make a football game", {
    engine: "claude-code",
    reviewPlan: true,
    autopilot: { hours: 1 },
  });
  assert.equal(f.records.get("chat")!.state, "failed");
  await controller.request("chat", "Make a football game", { engine: "codex", reviewPlan: true });
  assert.equal(f.records.get("chat")!.options.engine, "codex");
  assert.equal(f.records.get("chat")!.options.autopilot?.hours, 1);
  assert.equal(f.records.get("chat")!.state, "waiting");
  assert.equal(f.sent.length, 0);
});

test("a Stop pressed after its message was sent keeps that message's plan from being written", async () => {
  const f = fixture();
  let written = 0;
  f.host.generate = async () => {
    written++;
    return "1. Build the scene.";
  };
  // The message was sent, then Stop was pressed before the plan request began.
  const sentAt = Date.now() - 1_000;
  await f.controller.cancel("chat");
  await f.controller.request("chat", "Make a game", { reviewPlan: true }, { sentAt });
  assert.equal(written, 0, "no plan is written for a stopped message");
  assert.equal(f.records.get("chat")?.state, "cancelled", "the request is kept, cancelled");
  // A message sent after the Stop is planned as usual.
  await f.controller.request("chat", "Make a game", { reviewPlan: true }, { sentAt: Date.now() + 1_000 });
  assert.equal(written, 1);
  assert.equal(f.records.get("chat")?.state, "waiting");
});
