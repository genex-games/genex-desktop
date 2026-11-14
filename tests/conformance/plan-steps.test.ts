/**
 * The lead's plan as steps (seed loop/plan-steps.ts): named when it starts a build, carried on the
 * run's registration, named again at a save point when it changes, and read back by the app's run
 * summary, which the chat's Building card and Builds both show.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { savePointRound } from "../../src/harness-seed/loop/director/open/graph.ts";
import { MAX_PLAN_STEPS, MAX_STEP_CHARS, planSteps } from "../../src/harness-seed/loop/plan-steps.ts";
import { startAutopilot } from "../../src/harness-seed/loop/start-autopilot.ts";
import { argumentProblems } from "../../src/harness-seed/tools/index.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import { type EventEnvelope, EventKind } from "../../src/shared/event-log.ts";
import { summarizeRun } from "../../src/shared/run-summary.ts";

test("a plan keeps its named steps on one line each, cut to its longest, at most a few; junk names none", () => {
  assert.deepEqual(planSteps([" Three\n places ", "", 4, null, "Game code"]), ["Three places", "Game code"]);
  assert.deepEqual(
    planSteps("Three places\n\n Game code "),
    ["Three places", "Game code"],
    "a text names one step a line",
  );
  assert.equal(planSteps(42), null);
  assert.equal(planSteps([]), null);
  assert.equal(planSteps(["", "  "]), null);
  assert.equal(planSteps(Array.from({ length: 10 }, (_, i) => `s${i}`))?.length, MAX_PLAN_STEPS);
  const [long] = planSteps(["x".repeat(200)]) ?? [];
  assert.equal(Array.from(long ?? "").length, MAX_STEP_CHARS);
  assert.ok(long?.endsWith("…"));
});

test("a launch carries the steps it named, and a launch without them still starts", async () => {
  const params = startAutopilot.parameters as { required?: string[]; properties?: Record<string, unknown> };
  assert.ok(params.properties?.steps, "the tool names the plan's steps");
  assert.ok(!params.required?.includes("steps"), "a launch is never refused for its plan");
  const ctx = { engine: "vendor" } as never;
  type Launch = { details?: { run?: Record<string, unknown> } };
  const steps = ["Three places", "Game code"];
  const planned = (await startAutopilot.execute({ goal: "g", title: "T", steps }, ctx)) as Launch;
  assert.deepEqual(planned.details?.run?.steps, steps);
  const unplanned = (await startAutopilot.execute({ goal: "g", title: "T" }, ctx)) as Launch;
  assert.equal(unplanned.details?.run?.steps, undefined);
  assert.deepEqual(argumentProblems(params as never, { goal: "g", title: "T", steps }), []);
});

test("a save point that names the plan again replaces it in the run's summary", async () => {
  const log: EventEnvelope[] = [];
  const add = (eventType: string, payload: Record<string, unknown>) =>
    log.push({
      id: `e${log.length + 1}`,
      thread_id: "t1",
      session_id: null,
      turn_id: null,
      created_at: new Date(Date.UTC(2026, 10, 14, 9, log.length)).toISOString(),
      data: { type: EventKind.Custom, event_type: eventType, payload: { runId: "run_p", project: "game", ...payload } },
    });
  add(CustomEvent.RunRegistered, { steps: ["Three places", "Game code", "Light"] });
  const loopRun = {
    run: { runId: "run_p", project: "game" },
    ctx: { call: async () => null },
    appendRun: async (type: string, payload: Record<string, unknown>) => {
      add(type, payload);
    },
  };
  const point = { label: "Places", summary: "", snapshotId: "s1", auto: false, at: 0, notes: [] };
  await savePointRound(loopRun as never, { ...point, steps: ["Three places", "Light"] }, 1, []);
  assert.deepEqual(summarizeRun(log, "game", "run_p").steps, ["Three places", "Light"]);
});
