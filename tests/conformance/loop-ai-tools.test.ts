/**
 * The builder's play-time AI tools (`tools/ai-tools.ts`): the registry loads them (and never mistakes
 * their words module for a broken tool), each sends the host the call it names, and every hostile
 * argument is answered in a sentence before any host call — nothing the agent sends sizes a run.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { loadToolModules } from "../../src/harness-seed/tools/index.ts";
import { tools } from "../../src/harness-seed/tools/ai-tools.ts";
import { HostMethod } from "../../src/harness-seed/loop/host-methods.ts";
import { AI_BENCH_MAX_SAMPLES, AI_REPLAY_MAX_SEEDS, AiReplayAnswers } from "../../src/harness-seed/loop/ai-contract.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";
import type { ToolOutcome } from "../../src/harness-seed/types/harness.d.ts";

const PROJECT = "oracle";
const AI_METHODS = [
  HostMethod.AiSchemaCheck,
  HostMethod.AiTapes,
  HostMethod.AiReplay,
  HostMethod.AiRecord,
  HostMethod.AiBench,
  HostMethod.AiModelCheck,
];

/** A tool by name. */
function tool(name: string) {
  const found = tools.find((entry) => entry.name === name);
  assert.ok(found, `${name} is a tool`);
  return found;
}

/** Run a tool and read its outcome: every AI tool answers an object, never a bare sentence. */
async function run(name: string, args: Record<string, unknown>, ctx: unknown): Promise<ToolOutcome> {
  const outcome = await tool(name).execute(args, ctx as never);
  assert.ok(typeof outcome === "object", `${name} answers an outcome`);
  return outcome;
}

/** A recorder whose host answers every `ai.*` call with a fixed shape. */
function host(extra: Record<string, unknown> = {}) {
  return ctxRecorder({
    extra: { project: PROJECT, ...extra },
    handlers: {
      [HostMethod.AiSchemaCheck]: (p) =>
        JSON.stringify(p.schema).includes("$ref") ? { ok: false, problem: "unknown-keyword" } : { ok: true },
      [HostMethod.AiTapes]: () => [
        { name: "turn-three", calls: 9, sites: ["turn.resolve"], rejected: 0, bytes: 10, recordedAt: null },
      ],
      [HostMethod.AiReplay]: (p) => ({
        demo: p.demo,
        deterministic: true,
        stateDigests: [],
        misses: 0,
        fallbacks: 1,
        rejected: 0,
        settled: true,
        stuck: 0,
        refused: { ai_off: 4 },
      }),
      [HostMethod.AiRecord]: (p) => ({ demo: p.demo, file: `ai/tapes/${p.demo}.jsonl`, calls: 9, refused: 0 }),
      [HostMethod.AiBench]: (p) => ({
        site: p.site,
        model: { door: "local", engine: "ollama", model: "qwen3:4b" },
        samples: p.samples,
        fitted: 2,
        medianLatencyMs: 800,
        medianInputTokens: 300,
        medianOutputTokens: 90,
      }),
      [HostMethod.AiModelCheck]: () => ({
        project: PROJECT,
        state: "empty",
        moments: 0,
        progress: null,
        rows: [],
        recommended: null,
        checkedAt: null,
      }),
    },
  });
}

describe("the play-time AI tools", () => {
  it("load from the seed beside their words module, which is no tool and no broken module", async () => {
    const { modules, broken } = await loadToolModules(path.resolve("src/harness-seed"));
    assert.deepEqual(
      broken.map((entry) => entry.name),
      [],
    );
    assert.ok(!modules.some((module) => module.name.endsWith("-prompts.ts")));
    const names = modules.flatMap((module) => module.tools.map((entry) => entry.name));
    for (const name of ["ai_schema_check", "ai_tapes", "ai_replay", "ai_record", "ai_bench", "ai_model_check"])
      assert.ok(names.includes(name), name);
  });

  it("send the host the call each one names, with what the agent passed", async () => {
    const recorder = host();
    const ctx = recorder.ctx as never;
    assert.match(String((await run("ai_schema_check", { schema: '{"type":"string"}' }, ctx)).content), /fits/);
    assert.match(
      String((await run("ai_schema_check", { schema: { $ref: "#/x" } }, ctx)).content),
      /\$ref, pattern, anyOf/,
    );
    assert.match(String((await run("ai_tapes", {}, ctx)).content), /turn-three: 9 calls over turn\.resolve/);
    const replayed = await run("ai_replay", { demo: "turn-three", seeds: "4, 5", answers: "none" }, ctx);
    assert.match(String(replayed.content), /ai_off ×4/);
    await run("ai_replay", { demo: "turn-three" }, ctx);
    await run("ai_record", { demo: "turn-three", seed: "7" }, ctx);
    assert.match(
      String((await run("ai_bench", { site: "turn.resolve", samples: "2" }, ctx)).content),
      /2\/2 replies fit/,
    );
    assert.match(String((await run("ai_model_check", {}, ctx)).content), /record a playtest first/);
    assert.deepEqual(
      recorder.calls.map((call) => [call.method, call.params]),
      [
        [HostMethod.AiSchemaCheck, { schema: { type: "string" } }],
        [HostMethod.AiSchemaCheck, { schema: { $ref: "#/x" } }],
        [HostMethod.AiTapes, { project: PROJECT }],
        [HostMethod.AiReplay, { project: PROJECT, demo: "turn-three", seeds: [4, 5], answers: AiReplayAnswers.None }],
        [
          HostMethod.AiReplay,
          { project: PROJECT, demo: "turn-three", seeds: [1, 2, 3], answers: AiReplayAnswers.Tape },
        ],
        [HostMethod.AiRecord, { project: PROJECT, demo: "turn-three", seed: 7 }],
        [HostMethod.AiBench, { project: PROJECT, site: "turn.resolve", samples: 2 }],
        [HostMethod.AiModelCheck, { project: PROJECT }],
      ],
    );
  });

  it("say a host's failure in a sentence instead of throwing it at the turn", async () => {
    const recorder = ctxRecorder({
      extra: { project: PROJECT },
      handlers: {
        [HostMethod.AiRecord]: () => {
          throw new Error("play-time AI isn't running in this studio");
        },
      },
    });
    const outcome = await run("ai_record", { demo: "turn-three" }, recorder.ctx);
    assert.equal(outcome.ok, false);
    assert.match(String(outcome.content), /isn't running/);
  });

  const HOSTILE: Array<{ name: string; tool: string; args: Record<string, unknown>; extra?: Record<string, unknown> }> =
    [
      { name: "no game open", tool: "ai_tapes", args: {}, extra: { project: null } },
      { name: "a candidate's turn", tool: "ai_record", args: { demo: "a" }, extra: { candidateId: "c1" } },
      { name: "a climbing demo", tool: "ai_replay", args: { demo: "../../x" } },
      { name: "a demo with a separator", tool: "ai_record", args: { demo: "a/b" } },
      { name: "an uppercase demo", tool: "ai_replay", args: { demo: "Turn" } },
      { name: "a demo that is not text", tool: "ai_record", args: { demo: { name: "a" } } },
      { name: "no demo", tool: "ai_replay", args: {} },
      { name: "a negative seed", tool: "ai_record", args: { demo: "a", seed: "-1" } },
      { name: "a fractional seed", tool: "ai_replay", args: { demo: "a", seeds: "1.5" } },
      { name: "a seed past the safe integers", tool: "ai_record", args: { demo: "a", seed: "9007199254740993" } },
      {
        name: "more seeds than a replay runs",
        tool: "ai_replay",
        args: { demo: "a", seeds: Array.from({ length: AI_REPLAY_MAX_SEEDS + 1 }, (_, i) => i).join(",") },
      },
      { name: "a seed that is a word", tool: "ai_replay", args: { demo: "a", seeds: "1,two" } },
      { name: "an answer source it does not know", tool: "ai_replay", args: { demo: "a", answers: "live" } },
      { name: "a site with a space", tool: "ai_bench", args: { site: "turn resolve" } },
      { name: "a site that climbs", tool: "ai_bench", args: { site: "../turn" } },
      { name: "zero samples", tool: "ai_bench", args: { site: "turn.resolve", samples: "0" } },
      {
        name: "more samples than a bench takes",
        tool: "ai_bench",
        args: { site: "a", samples: AI_BENCH_MAX_SAMPLES + 1 },
      },
      { name: "a schema that is not JSON", tool: "ai_schema_check", args: { schema: "{type: string" } },
      { name: "no schema", tool: "ai_schema_check", args: {} },
    ];
  for (const row of HOSTILE) {
    it(`answer ${row.name} with a sentence and no host call`, async () => {
      const recorder = host(row.extra);
      const outcome = await run(row.tool, row.args, recorder.ctx);
      assert.equal(outcome.ok, false);
      assert.ok(String(outcome.content).length > 0);
      assert.deepEqual(
        recorder.sequence((method) => AI_METHODS.includes(method as never)),
        [],
      );
    });
  }

  it("never pass a field that would size or widen the host's run budget", async () => {
    const recorder = host();
    const widen = { maxCalls: 1e9, concurrency: 8, doors: ["byok"], budget: { maxCalls: 1e9 }, localOnly: false };
    await run("ai_record", { demo: "a", ...widen }, recorder.ctx);
    await run("ai_bench", { site: "a", ...widen }, recorder.ctx);
    await run("ai_model_check", { ...widen }, recorder.ctx);
    assert.deepEqual(
      recorder.calls.map((call) => Object.keys(call.params).sort()),
      [["demo", "project", "seed"], ["project", "samples", "site"], ["project"]],
    );
  });
});
