import assert from "node:assert/strict";
import { it } from "node:test";
import { operationSchema } from "../../src/main/dev/protocol.ts";

it("developer graph operations accept bounded diagnostics and reject arbitrary injection", () => {
  assert.equal(
    operationSchema.safeParse({ method: "graph.drag", params: { durationMs: 2000, distanceX: 160, steps: 60 } })
      .success,
    true,
  );
  assert.equal(
    operationSchema.safeParse({ method: "fixture.graph", params: { action: "other-project-frames" } }).success,
    true,
  );
  for (const params of [
    { durationMs: 60000, distanceX: 1, steps: 60 },
    { durationMs: 2000, distanceX: 10000, steps: 60 },
    { durationMs: 2000, distanceX: 1, steps: 100000 },
    { durationMs: 2000, distanceX: 1, steps: 60, script: "arbitrary()" },
  ]) {
    assert.equal(operationSchema.safeParse({ method: "graph.drag", params }).success, false);
  }
  for (const action of ["eval", "../live", "preview.frame", "", "append-round;unlink"]) {
    assert.equal(operationSchema.safeParse({ method: "fixture.graph", params: { action } }).success, false);
  }
});

it("fixture graph mutation refuses nonfixture identities before any host side effect", async () => {
  const { applyGraphFixture } = await import("../../src/main/dev/fixture-graph-control.ts");
  const { GraphFixtureAction } = await import("../../src/main/dev/protocol.ts");
  let effects = 0;
  const host = {
    thread: async () => {
      effects++;
      return "lead";
    },
    events: async () => [],
    append: async () => {
      effects++;
    },
    frame: () => {
      effects++;
    },
    close: () => {
      effects++;
    },
    changed: () => {
      effects++;
    },
  };
  for (const identity of [
    { providers: "live", fixture: "large-build-graph" },
    { providers: "fixture", fixture: "build-graph" },
    { providers: "fixture", fixture: "../large-build-graph" },
    { providers: "fixture", fixture: null },
  ])
    await assert.rejects(applyGraphFixture(identity, GraphFixtureAction.AppendRound, host), /requires the large/);
  assert.equal(effects, 0);
});

it("the fixture append keeps lead-run order and follows the existing facet iteration", async () => {
  const { applyGraphFixture } = await import("../../src/main/dev/fixture-graph-control.ts");
  const { GraphFixtureAction } = await import("../../src/main/dev/protocol.ts");
  const { largeBuildGraph } = await import("../helpers/large-build-graph.ts");
  const { customRecord } = await import("../../src/shared/custom-events.ts");
  const emitted: import("../../src/shared/event-log.ts").EventData[] = [];
  let changed = 0;
  await applyGraphFixture({ providers: "fixture", fixture: "large-build-graph" }, GraphFixtureAction.AppendRound, {
    thread: async () => "lead",
    events: async () => largeBuildGraph().events,
    append: async (events, thread) => {
      assert.equal(thread, "lead");
      emitted.push(...events);
    },
    frame: () => assert.fail("not a frame pulse"),
    close: () => assert.fail("not a frame pulse"),
    changed: () => {
      changed++;
    },
  });
  assert.equal(emitted.length, 3);
  for (const event of emitted) {
    const data = customRecord(event);
    assert.equal(data?.payload.runId, "performance-run");
    assert.equal(data?.payload.iteration, 201);
  }
  assert.equal(changed, 1);
});

it("the fixture's worker frames start a run with a try in hand and show its builder at work", async () => {
  const { applyGraphFixture } = await import("../../src/main/dev/fixture-graph-control.ts");
  const { GraphFixtureAction } = await import("../../src/main/dev/protocol.ts");
  const { largeBuildGraph } = await import("../helpers/large-build-graph.ts");
  const { customRecord, CustomEvent } = await import("../../src/shared/custom-events.ts");
  const emitted: import("../../src/shared/event-log.ts").EventData[] = [];
  const frames: import("../../src/shared/agent-screen.ts").AgentScreenFrame[] = [];
  await applyGraphFixture({ providers: "fixture", fixture: "large-build-graph" }, GraphFixtureAction.WorkerFrames, {
    thread: async () => "lead",
    events: async () => largeBuildGraph().events,
    append: async (events) => {
      emitted.push(...events);
    },
    frame: (frame) => frames.push(frame),
    close: () => assert.fail("the builder's window stays open"),
    changed: () => {},
  });
  assert.deepEqual(
    emitted.map((event) => customRecord(event)?.event_type),
    [CustomEvent.RunStarted, CustomEvent.FacetMove, CustomEvent.FacetBuildStarted],
    "no judged round: the try stays in hand",
  );
  const runIds = [...new Set(emitted.map((event) => customRecord(event)?.payload.runId))];
  assert.equal(runIds.length, 1);
  const started = customRecord(emitted[2] ?? { type: "custom", event_type: "", payload: {} });
  assert.ok(frames.length >= 2);
  for (const frame of frames) {
    assert.equal(frame.runId, runIds[0], "the frames are the running run's");
    assert.equal(frame.facetId, started?.payload.facetId);
    assert.ok(frame.act, "every frame says what the builder did");
  }
});
