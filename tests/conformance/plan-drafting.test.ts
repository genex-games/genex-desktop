/**
 * Characterization of the plan a reviewed request asks the lead for: the one tool-free completion
 * the core sends when a message arrives with "Review plan" on, and what it records around it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureEngines } from "../../src/main/dev/fixtures.ts";
import type { PlanReview } from "../../src/shared/composer.ts";
import type { CompleteRequest } from "../../src/substrate/engines/types.ts";
import { coreLite } from "../helpers/core-lite.ts";

const SYSTEM_PROMPT =
  "Write a concise implementation plan for the requested game or change in the existing conversation. Preserve the previous plan, decisions and completed work; revise only what the latest request changes. This is a planning-only step before explicit user approval. Do not execute work or call tools. Write a concise plan the person can approve or change. Do not claim to have inspected files. Return only the plan.";

async function fixtureCore() {
  const { core } = await coreLite({ engines: fixtureEngines() });
  const thread = await core.createGameThread();
  const [engine] = core.engines.all();
  assert.ok(engine);
  return { core, thread, engine };
}

async function planningCore() {
  const { core, thread, engine } = await fixtureCore();
  const requests: CompleteRequest[] = [];
  const plans = ["First plan", "Second plan"];
  engine.complete = async (request) => {
    requests.push(request);
    const content = plans[requests.length - 1] ?? "Later plan";
    return {
      message: { role: "assistant", content },
      usage: {},
      stopReason: "end",
      model: "fixture",
      engine: engine.id,
    };
  };
  return { core, thread, engine, requests };
}

/** The request's one user message, split into its blank-line separated sections. */
function contextSections(request: CompleteRequest | undefined): string[] {
  assert.ok(request);
  assert.equal(request.messages.length, 1);
  return String(request.messages[0]?.content).split("\n\n");
}

test("a reviewed request asks the lead for a tool-free plan with the conversation and the request", async () => {
  const { core, thread, engine, requests } = await planningCore();
  const said = Array.from({ length: 22 }, (_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `line ${i}`,
  }));
  await core.append([{ type: "messages", messages: said }], thread);

  await core.sendUserMessage("Make a garden", { thread, engine: engine.id, reviewPlan: true });

  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.equal(request?.systemPrompt, SYSTEM_PROMPT);
  assert.equal(request?.maxTokens, 4096);
  assert.deepEqual(request?.tools, []);
  const sections = contextSections(request);
  assert.match(sections[0] ?? "", /planning is tool-free/);
  const recent = said
    .slice(-20)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");
  assert.deepEqual(sections.slice(-3), [
    "Original request: line 0",
    `Recent conversation:\n${recent}`,
    "Latest request:\nMake a garden",
  ]);

  const events = await core.store.listEvents(thread);
  const applied = events.flatMap((e) =>
    e.data.type === "custom" && e.data.event_type === "planning_capabilities_applied" ? [e.data.payload] : [],
  );
  assert.equal(applied.length, 1);
  const payload = applied[0] as { revision: number; engine: string; project: string | null };
  assert.deepEqual(payload, { revision: payload.revision, engine: engine.id, project: null });
});

test("a revision carries the previous proposed plan, and a long conversation is cut to its end", async () => {
  const { core, thread, engine, requests } = await planningCore();
  const long = "x".repeat(20_000);
  await core.append([{ type: "messages", messages: [{ role: "user", content: long }] }], thread);

  await core.sendUserMessage("Make a garden", { thread, engine: engine.id, reviewPlan: true });
  const pending = (await core.store.getRecord(thread)).metadata?.planReview as PlanReview;
  assert.equal(pending.plan, "First plan");
  await core.sendUserMessage("Make the flowers blue", { thread });

  assert.equal(requests.length, 2);
  const sections = contextSections(requests[1]);
  const recent = sections.find((s) => s.startsWith("Recent conversation:\n")) ?? "";
  assert.equal(recent.length, "Recent conversation:\n".length + 18_000);
  assert.ok(recent.endsWith("x"));
  assert.deepEqual(sections.slice(-3), [
    "Previous proposed plan:\nFirst plan",
    "Latest request:\nMake a garden",
    "Requested revision:\nMake the flowers blue",
  ]);
});

test("a provider without completions cannot plan, and the review says so", async () => {
  const { core, thread, engine } = await fixtureCore();
  engine.complete = undefined;
  await core.sendUserMessage("Make a garden", { thread, engine: engine.id, reviewPlan: true });
  const review = (await core.store.getRecord(thread)).metadata?.planReview as PlanReview;
  assert.equal(review.state, "failed");
  assert.equal(review.error, "This provider cannot prepare a reviewable plan. Choose another model.");
});
