import { it } from "node:test";
import assert from "node:assert/strict";
import { argsDigest, finishedPayload, resultDigest, roleOf, startedPayload } from "../../src/main/plugin-activity.ts";
import { digestOperation } from "../../src/shared/game-assets.ts";

const start = (over: Partial<Parameters<typeof startedPayload>[0]> = {}) =>
  startedPayload({
    pluginId: "genex",
    pluginName: "Genex Tools",
    tool: "asset",
    toolName: "genex__asset",
    args: { operation: "image", prompt: "a barn at dusk" },
    project: "farm",
    engine: "claude-code",
    role: "builder",
    ...over,
  });

it("the arguments digest leads with what a generation varies and never grows past a chat line", () => {
  assert.equal(
    argsDigest({ prompt: "a barn", id: "job-1", operation: "image" }),
    "operation=image prompt=a barn id=job-1",
  );
  // Declared-but-unnamed scalars follow; objects and functions are not unfolded.
  assert.equal(argsDigest({ options: { seed: 3 }, loud: true, count: 2 }), "loud=true count=2");
  assert.equal(argsDigest({ prompt: "x\n  y\tz" }), "prompt=x y z");
  assert.equal(argsDigest(null), "");
  assert.equal(argsDigest("not an object"), "");
  const long = argsDigest({ prompt: "a barn at dusk ".repeat(60) });
  assert.ok(long.length <= 200, String(long.length));
  assert.ok(long.endsWith("…"));
  // Prose is never mistaken for encoded bytes, however long it runs.
  assert.match(
    argsDigest({ prompt: "an unbroken sentence about a barn that runs well past sixty four characters" }),
    /^prompt=an unbroken/,
  );
});

it("the chat reads a call's operation back from its digest, and only from the operation field", () => {
  assert.equal(digestOperation(argsDigest({ operation: "shoot" })), "shoot");
  assert.equal(digestOperation(argsDigest({ prompt: "x operation=status", operation: "shoot" })), "shoot");
  assert.equal(digestOperation(argsDigest({ prompt: "operation=shoot" })), null, "a prompt that mentions one");
  assert.equal(digestOperation(argsDigest({ id: "job-1" })), null);
  assert.equal(digestOperation(""), null);
  assert.equal(digestOperation(undefined), null);
});

it("neither digest can carry image bytes out of a tool result", () => {
  const base64 = Buffer.from(Array.from({ length: 3000 }, (_, i) => i % 256)).toString("base64");
  const digest = resultDigest({
    id: "job-1",
    images: [{ mimeType: "image/png", data: base64 }],
    approval: { images: [base64] },
    preview: `data:image/png;base64,${base64}`,
    blob: base64,
  });
  assert.equal(digest.includes(base64.slice(0, 64)), false);
  assert.equal(digest.includes("approval"), false);
  assert.match(digest, /data url omitted/);
  assert.match(digest, /base64 omitted/);
  assert.equal(argsDigest({ prompt: `data:image/png;base64,${base64}` }).includes(base64.slice(0, 64)), false);
  // A record that refers to itself is bounded by the depth cap, never a throw and never endless.
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const bounded = resultDigest(cyclic);
  assert.ok(bounded.length <= 4096, String(bounded.length));
  assert.match(bounded, /\[…\]/);
});

it("the result digest is capped and the cap is the whole payload, not one field", () => {
  const digest = resultDigest({ notes: Array.from({ length: 400 }, (_, i) => `line ${i} ${"y".repeat(200)}`) });
  assert.ok(digest.length <= 4096, String(digest.length));
});

it("the role is derived, because a delegate request never carries one", () => {
  assert.equal(roleOf({ director: { runId: "r1" }, selfCapture: { runId: "r1" } }), "director");
  assert.equal(roleOf({ selfCapture: { runId: "r1" } }), "builder");
  assert.equal(roleOf({}), "chat");
});

it("the started payload keeps worker attribution at the top level, where the graph looks for it", () => {
  const payload = start({ runId: "run-9", facetId: "world", iteration: 2, threadId: "t1" });
  assert.equal(payload.runId, "run-9");
  assert.equal(payload.facetId, "world");
  assert.equal(payload.iteration, 2);
  assert.equal(payload.pluginName, "Genex Tools");
  assert.equal(payload.tool, "asset");
  assert.equal(payload.toolName, "genex__asset");
  assert.match(payload.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.notEqual(payload.callId, start().callId);
  const bare = start();
  assert.equal("runId" in bare, false);
  assert.equal("facetId" in bare, false);
  assert.equal("iteration" in bare, false);
  assert.equal("threadId" in bare, false);
});

it("the finished payload echoes the start and reads the ids a delivery is joined on", () => {
  const started = start({ runId: "run-9", threadId: "t1" });
  const done = finishedPayload(
    started,
    {
      result: { id: "job-7", generationId: "gen-3", files: ["assets/genex/job-7/a.png"], status: "downloaded" },
      version: "1.0.0",
    },
    2,
    1234.6,
  );
  assert.equal(done.callId, started.callId);
  assert.equal(done.runId, "run-9");
  assert.equal(done.ok, true);
  assert.equal(done.jobId, "job-7");
  assert.equal(done.generationId, "gen-3");
  assert.deepEqual(done.files, ["assets/genex/job-7/a.png"]);
  assert.equal(done.images, 2);
  assert.equal(done.durationMs, 1235);
  assert.equal(done.version, "1.0.0");
  assert.equal("error" in done, false);
  assert.match(done.result, /"status":"downloaded"/);
});

it("a result that is not a job record yields no ids, and a throw is recorded as a failure", () => {
  const started = start();
  const plain = finishedPayload(started, { result: { text: "ok" } }, 0, 5);
  assert.equal("jobId" in plain, false);
  assert.equal("files" in plain, false);
  assert.equal(plain.images, 0);
  // An `id` alone is not a job: only a record that also names files or a generation is read as one.
  assert.equal("jobId" in finishedPayload(started, { result: { id: "x" } }, 0, 5), false);
  const failed = finishedPayload(started, { error: new Error("Genex is not connected") }, 0, 12);
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "Genex is not connected");
  assert.equal(failed.result, "");
  assert.equal(failed.callId, started.callId);
  const negative = finishedPayload(started, { result: {} }, -3, -1);
  assert.equal(negative.images, 0);
  assert.equal(negative.durationMs, 0);
});
