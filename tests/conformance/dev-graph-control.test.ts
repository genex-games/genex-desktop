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

it("a file drag drags only the control's own samples, never a path the request names", () => {
  for (const stage of ["over", "drop", "leave"])
    assert.equal(
      operationSchema.safeParse({ method: "file.drag", params: { selector: "[data-promptbar]", stage } }).success,
      true,
    );
  for (const params of [
    { selector: "[data-promptbar]", stage: "drop", file: "/etc/passwd" },
    { selector: "[data-promptbar]", stage: "drop", file: "../picture" },
    { selector: "[data-promptbar]", stage: "drop", path: "/Users/someone/secret.png" },
    { selector: "[data-promptbar]", stage: "drop", files: ["/tmp/a.png"] },
    { selector: "[data-promptbar]", stage: "hover" },
    { stage: "drop" },
  ])
    assert.equal(operationSchema.safeParse({ method: "file.drag", params }).success, false, JSON.stringify(params));
});

it("a file drag hovers, lets go or cancels at the target", async () => {
  const { fileDragEvents } = await import("../../src/main/dev/file-drag.ts");
  const at = { x: 10, y: 20 };
  const types = (stage: "over" | "drop" | "leave") =>
    fileDragEvents(stage, at, "/profile/dev-drag/sample-picture.png").map((event) => event.type);
  assert.deepEqual(types("over"), ["dragEnter", "dragOver"]);
  assert.deepEqual(types("drop"), ["dragEnter", "dragOver", "drop"]);
  assert.deepEqual(types("leave"), ["dragOver", "dragCancel"]);
  assert.deepEqual(
    fileDragEvents("leave", at, "/f.png").map(({ x, y }) => [x, y]),
    [
      [0, 0],
      [0, 0],
    ],
    "Leave moves off the target before it cancels",
  );
  const [enter] = fileDragEvents("drop", at, "/profile/dev-drag/sample-picture.png");
  assert.deepEqual(enter, {
    type: "dragEnter",
    x: 10,
    y: 20,
    data: { items: [], files: ["/profile/dev-drag/sample-picture.png"], dragOperationsMask: 1 },
  });
});

it("the drag samples are written inside the control's folder: a picture the composer takes, and a text file", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { writeDragSample } = await import("../../src/main/dev/file-drag.ts");
  const dir = await mkdtemp(path.join(os.tmpdir(), "dev-drag-"));
  try {
    const picture = await writeDragSample(path.join(dir, "dev-drag"), "picture");
    assert.equal(path.dirname(picture.file), path.join(dir, "dev-drag"));
    assert.equal(picture.mimeType, "image/png");
    assert.deepEqual([...(await readFile(picture.file)).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    const text = await writeDragSample(path.join(dir, "dev-drag"), "text");
    assert.equal(text.mimeType, "text/plain");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
