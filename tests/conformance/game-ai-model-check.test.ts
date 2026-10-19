/**
 * The model check (D10, D12; `main/game-ai/model-check.ts`): optional, on the creator's own models
 * only (this Mac, their key, their plan when they allowed it; never Genex credits), over a dynamic
 * set (the standard panel's picks the creator can run, then every other model they connected, at
 * most twelve). Each saved moment of their playtests is replayed on each model with the game's one
 * repair; a judge on their own model compares the answers with the playtest's; each row says how
 * the model fits, what it costs here and how fast it answers. The result, the creator's pick and
 * what Publish shows survive a restart; a stop leaves the last result as it was.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AI_CHECK_MAX_MODELS,
  AiCheckFit,
  AiCheckState,
  AiCostLevel,
  type AiCheckResult,
} from "../../src/shared/game-ai-check.ts";
import {
  AiDoor,
  AiErrorCode,
  AiFunding,
  type AiModelRef,
  createGameKey,
  playGameKey,
} from "../../src/shared/game-ai.ts";
import type { DoorReadiness } from "../../src/shared/game-ai-route.ts";
import type { AiMoment } from "../../src/main/game-ai/moments.ts";
import {
  CHECK_MAX_MOMENTS,
  CHECK_SITE,
  checksFile,
  createModelCheck,
  type ModelCheckDeps,
} from "../../src/main/game-ai/model-check.ts";
import type { AiDoorRequest, AiSlotResult, GameAiDoorImpl } from "../../src/main/game-ai/types.ts";
import { heldClock, requestOf } from "../helpers/game-ai-traces.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PROJECT = "Lantern Run";
const ENGINE_OF: Partial<Record<AiDoor, string>> = {
  [AiDoor.Local]: "ollama",
  [AiDoor.Byok]: "openrouter",
  [AiDoor.Plan]: "claude",
  [AiDoor.OpenCode]: "opencode",
  [AiDoor.GenexCredits]: "genex",
};
const ref = (door: AiDoor, model: string): AiModelRef => ({ door, engine: ENGINE_OF[door] ?? "x", model });

const QWEN = ref(AiDoor.Local, "qwen3:8b");
const LLAMA = ref(AiDoor.Local, "llama3.2:3b");
const HAIKU = ref(AiDoor.Byok, "anthropic/claude-haiku-4.5");
const FLASH = ref(AiDoor.Byok, "google/gemini-2.5-flash");

/** `n` saved moments the creator's playtest got on qwen. */
function moments(n: number): AiMoment[] {
  return Array.from({ length: n }, (_, i) => ({
    key: i.toString(16).padStart(64, "0"),
    request: requestOf({ prompt: `Moment ${i}: what is on the menu?` }),
    value: { line: `Stew ${i}` },
    model: QWEN,
    at: "2026-10-20T18:00:00.000Z",
  }));
}

type Reply = (model: string, call: AiDoorRequest, signal: AbortSignal) => string | Promise<string>;

/** A door with `models`, answering with `reply`, recording each call; the clock moves `latencyMs` a call. */
function door(
  kind: AiDoor,
  models: string[],
  reply: Reply,
  clock: ReturnType<typeof heldClock>,
  options: { ready?: boolean; cost?: number; latencyMs?: number } = {},
) {
  const runs: Array<{ model: string; call: AiDoorRequest; signal: AbortSignal }> = [];
  const impl: GameAiDoorImpl = {
    door: kind,
    readiness: async (): Promise<DoorReadiness> => ({
      door: kind,
      ready: options.ready ?? true,
      json: true,
      loading: false,
      maxInputTokens: 100_000,
    }),
    models: async () => models.map((model) => ref(kind, model)),
    worstCaseMicros: () => 0,
    run: async (call, signal) => {
      runs.push({ model: call.model.model, call, signal });
      clock.advance(options.latencyMs ?? 500);
      const text = await reply(call.model.model, call, signal);
      return {
        text,
        model: call.model.model,
        usage: { inputTokens: 40, outputTokens: 8 },
        costMicros: options.cost ?? 0,
      };
    },
  };
  return { impl, runs };
}

const fits: Reply = (_model, call) => {
  if (call.request.site === CHECK_SITE) return judgeAll(call, true);
  return '{"line":"Stew and bread."}';
};

/** A judge that says every answer plays as well (or none). */
function judgeAll(call: AiDoorRequest, verdict: boolean): string {
  const count = Number(/There are (\d+) moments/.exec(call.request.prompt)?.[1] ?? 0);
  return JSON.stringify({
    verdicts: Array.from({ length: count }, () => verdict),
    note: verdict ? "" : "Forgets the menu.",
  });
}

/** A model check over `doors` and `n` moments, in a fresh folder. */
async function check(
  build: (clock: ReturnType<typeof heldClock>) => Array<ReturnType<typeof door>>,
  { momentCount = 4, ...options }: Partial<ModelCheckDeps> & { momentCount?: number } = {},
) {
  const clock = heldClock();
  const doors = build(clock);
  const dir = options.dir ?? (await tmpDir("studio-model-check-"));
  const acquired: string[] = [];
  let released = 0;
  const saved = moments(momentCount);
  const deps: ModelCheckDeps = {
    clock,
    dir,
    doors: new Map(doors.map((one) => [one.impl.door, one.impl])),
    moments: { list: async () => saved },
    queue: {
      acquire: async (kind): Promise<AiSlotResult> => {
        acquired.push(kind);
        return {
          ok: true,
          release: () => {
            released += 1;
          },
        };
      },
      building: () => {},
    },
    allowPlan: async () => false,
    label: (model) => `label:${model.model}`,
    playerCostMicros: () => null,
    creatorShareBps: async () => null,
    wait: async () => {},
    ...options,
  };
  const service = createModelCheck(deps);
  return { service, doors, dir, clock, deps, acquired, released: () => released };
}

const rowModels = (result: AiCheckResult) => result.rows.map((row) => row.model.model).sort();

describe("what the model check runs on", () => {
  it("has nothing to check before a playtest with AI", async () => {
    const fx = await check((clock) => [door(AiDoor.Local, ["qwen3:8b"], fits, clock)], { momentCount: 0 });
    assert.equal((await fx.service.state(PROJECT)).state, AiCheckState.Empty);
    assert.equal((await fx.service.start(PROJECT, { localOnly: false })).state, AiCheckState.Empty);
    assert.equal(fx.doors[0]?.runs.length, 0);
  });

  it("runs the creator's own models, every connected one, and never Genex credits", async () => {
    const fx = await check((clock) => [
      door(AiDoor.Local, ["qwen3:8b", "llama3.2:3b"], fits, clock),
      door(AiDoor.Byok, [HAIKU.model, FLASH.model], fits, clock),
      door(AiDoor.GenexCredits, ["genex-default"], fits, clock),
    ]);
    const started = await fx.service.start(PROJECT, { localOnly: false });
    assert.equal(started.state, AiCheckState.Checking);
    assert.deepEqual(started.progress, { done: 0, total: 4 });
    const done = await fx.service.settled(PROJECT);
    assert.equal(done.state, AiCheckState.Done);
    assert.deepEqual(rowModels(done), [HAIKU.model, FLASH.model, LLAMA.model, QWEN.model].sort());
    assert.equal(fx.doors[2]?.runs.length, 0, "Genex credits are never used");
    assert.equal(fx.acquired.length, fx.released(), "every slot taken is given back");
  });

  it("leaves out a door that is not ready, and the plan unless the creator allowed it", async () => {
    const build = (clock: ReturnType<typeof heldClock>) => [
      door(AiDoor.Local, ["qwen3:8b"], fits, clock),
      door(AiDoor.Byok, [HAIKU.model], fits, clock, { ready: false }),
      door(AiDoor.Plan, ["claude-haiku-4-5"], fits, clock),
    ];
    const closed = await check(build);
    await closed.service.start(PROJECT, { localOnly: false });
    assert.deepEqual(rowModels(await closed.service.settled(PROJECT)), [QWEN.model]);
    const open = await check(build, { allowPlan: async () => true });
    await open.service.start(PROJECT, { localOnly: false });
    assert.deepEqual(rowModels(await open.service.settled(PROJECT)), ["claude-haiku-4-5", QWEN.model]);
  });

  it("runs only this Mac's models for the harness", async () => {
    const fx = await check((clock) => [
      door(AiDoor.Local, ["qwen3:8b"], fits, clock),
      door(AiDoor.Byok, [HAIKU.model], fits, clock),
    ]);
    await fx.service.start(PROJECT, { localOnly: true });
    assert.deepEqual(rowModels(await fx.service.settled(PROJECT)), [QWEN.model]);
    assert.equal(fx.doors[1]?.runs.length, 0);
  });

  it("checks at most twelve models, the standard panel's picks first", async () => {
    const many = Array.from({ length: 20 }, (_, i) => `vendor/model-${i}`);
    const fx = await check((clock) => [
      door(AiDoor.Byok, [...many, "anthropic/claude-sonnet-4.5", HAIKU.model], fits, clock),
      door(AiDoor.Local, ["qwen3:8b", "llama3.2:3b", "qwen3:32b"], fits, clock),
    ]);
    await fx.service.start(PROJECT, { localOnly: false });
    const models = rowModels(await fx.service.settled(PROJECT));
    assert.equal(models.length, AI_CHECK_MAX_MODELS);
    for (const pick of [HAIKU.model, "anthropic/claude-sonnet-4.5", "llama3.2:3b", "qwen3:32b"])
      assert.ok(models.includes(pick), pick);
  });

  it("replays at most its moment cap, the newest", async () => {
    const fx = await check((clock) => [door(AiDoor.Local, ["qwen3:8b"], fits, clock)], {
      momentCount: CHECK_MAX_MOMENTS + 6,
    });
    await fx.service.start(PROJECT, { localOnly: false });
    const done = await fx.service.settled(PROJECT);
    assert.equal(done.moments, CHECK_MAX_MOMENTS);
    const prompts = fx.doors[0]?.runs
      .filter((run) => run.call.request.site !== CHECK_SITE)
      .map((run) => run.call.request.prompt);
    assert.equal(prompts?.length, CHECK_MAX_MOMENTS);
    assert.match(prompts?.at(-1) ?? "", new RegExp(`Moment ${CHECK_MAX_MOMENTS + 5}:`));
  });
});

describe("a model's row", () => {
  it("fits when its answers fit the game and the judge agrees, else struggles with a note", async () => {
    const reply: Reply = (model, call) => {
      if (call.request.site === CHECK_SITE) return judgeAll(call, !call.request.prompt.includes("Soup only"));
      if (model === "llama3.2:3b") return '{"line":"Soup only"}';
      if (model === FLASH.model) return "Stew, I think";
      return '{"line":"Stew and bread."}';
    };
    const fx = await check((clock) => [
      door(AiDoor.Local, ["qwen3:8b", "llama3.2:3b"], reply, clock),
      door(AiDoor.Byok, [FLASH.model], reply, clock),
    ]);
    await fx.service.start(PROJECT, { localOnly: false });
    const done = await fx.service.settled(PROJECT);
    const row = (model: string) => done.rows.find((one) => one.model.model === model);
    assert.equal(row(QWEN.model)?.fit, AiCheckFit.Fits);
    assert.equal(row(QWEN.model)?.fitted, 4);
    assert.equal(row(LLAMA.model)?.fit, AiCheckFit.Struggles);
    assert.equal(row(LLAMA.model)?.note, "Forgets the menu.");
    assert.equal(row(FLASH.model)?.fit, AiCheckFit.Struggles);
    assert.equal(row(FLASH.model)?.fitted, 0);
    assert.match(row(FLASH.model)?.note ?? "", /4 of 4/);
    assert.equal(row(QWEN.model)?.label, "label:qwen3:8b");
  });

  it("counts an answer fixed by the game's one repair as fitting", async () => {
    const reply: Reply = (_model, call) => {
      if (call.request.site === CHECK_SITE) return judgeAll(call, true);
      return call.repair ? '{"line":"Stew."}' : "not json";
    };
    const fx = await check((clock) => [door(AiDoor.Local, ["qwen3:8b"], reply, clock)]);
    await fx.service.start(PROJECT, { localOnly: false });
    const done = await fx.service.settled(PROJECT);
    assert.equal(done.rows[0]?.fit, AiCheckFit.Fits);
    const repairs = fx.doors[0]?.runs.filter((run) => run.call.repair !== null) ?? [];
    assert.equal(repairs.length, 4);
    assert.deepEqual(repairs[0]?.call.repair?.previous, "not json");
  });

  it("is untested on too few moments, and checks schema alone when the judge cannot answer", async () => {
    const reply: Reply = (_model, call) => (call.request.site === CHECK_SITE ? "no verdicts" : '{"line":"Stew."}');
    const few = await check((clock) => [door(AiDoor.Local, ["qwen3:8b"], reply, clock)], { momentCount: 2 });
    await few.service.start(PROJECT, { localOnly: false });
    assert.equal((await few.service.settled(PROJECT)).rows[0]?.fit, AiCheckFit.Untested);
    const enough = await check((clock) => [door(AiDoor.Local, ["qwen3:8b"], reply, clock)]);
    await enough.service.start(PROJECT, { localOnly: false });
    assert.equal((await enough.service.settled(PROJECT)).rows[0]?.fit, AiCheckFit.Fits);
  });

  it("counts a model that fails to answer as not fitting, and says so", async () => {
    const reply: Reply = () => {
      throw new Error("provider down");
    };
    const fx = await check((clock) => [door(AiDoor.Local, ["qwen3:8b"], reply, clock)]);
    await fx.service.start(PROJECT, { localOnly: false });
    const [row] = (await fx.service.settled(PROJECT)).rows;
    assert.equal(row?.fit, AiCheckFit.Struggles);
    assert.equal(row?.medianLatencyMs, null);
    assert.match(row?.note ?? "", /4 of 4/);
  });

  const costs: Array<[string, AiDoor, string, number, AiFunding, AiCostLevel]> = [
    ["a model on this Mac", AiDoor.Local, "qwen3:8b", 0, AiFunding.Free, AiCostLevel.Free],
    ["a free model on the person's key", AiDoor.Byok, "vendor/free-model", 0, AiFunding.Free, AiCostLevel.Free],
    ["a cheap model on the person's key", AiDoor.Byok, "vendor/cheap", 800, AiFunding.Key, AiCostLevel.Low],
    ["a mid model on the person's key", AiDoor.Byok, "vendor/mid", 6_000, AiFunding.Key, AiCostLevel.Medium],
    ["a dear model on the person's key", AiDoor.Byok, "vendor/dear", 40_000, AiFunding.Key, AiCostLevel.High],
  ];
  for (const [name, kind, model, cost, funding, level] of costs)
    it(`prices ${name}`, async () => {
      const fx = await check((clock) => [door(kind, [model], fits, clock, { cost })]);
      await fx.service.start(PROJECT, { localOnly: false });
      const [row] = (await fx.service.settled(PROJECT)).rows;
      assert.deepEqual([row?.funding, row?.cost], [funding, level]);
    });

  it("times each answer by the clock", async () => {
    const fx = await check((clock) => [door(AiDoor.Local, ["qwen3:8b"], fits, clock, { latencyMs: 700 })]);
    await fx.service.start(PROJECT, { localOnly: false });
    assert.equal((await fx.service.settled(PROJECT)).rows[0]?.medianLatencyMs, 700);
  });

  it("waits for a slot the queue holds for a build, then runs", async () => {
    const waits: number[] = [];
    let refusals = 1;
    const fx = await check((clock) => [door(AiDoor.Local, ["qwen3:8b"], fits, clock)], {
      wait: async (ms) => {
        waits.push(ms);
      },
      queue: {
        acquire: async (): Promise<AiSlotResult> => {
          if (refusals-- > 0) return { ok: false, code: AiErrorCode.LocalLoading, retryAfterMs: 1_500 };
          return { ok: true, release: () => {} };
        },
        building: () => {},
      },
    });
    await fx.service.start(PROJECT, { localOnly: false });
    assert.equal((await fx.service.settled(PROJECT)).rows[0]?.fit, AiCheckFit.Fits);
    assert.deepEqual(waits, [1_500]);
  });
});

describe("the check's lifetime", () => {
  it("stops a running check, aborts its call and keeps the last result", async () => {
    const signals: AbortSignal[] = [];
    const reply: Reply = (_model, _call, signal) => {
      signals.push(signal);
      if (signals.length === 1) return '{"line":"Stew."}';
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    };
    const fx = await check((clock) => [door(AiDoor.Local, ["qwen3:8b"], reply, clock)]);
    await fx.service.start(PROJECT, { localOnly: false });
    while (signals.length < 2) await new Promise((resolve) => setImmediate(resolve));
    const stopped = await fx.service.stop(PROJECT);
    assert.equal(stopped.state, AiCheckState.Ready);
    assert.equal(signals.at(-1)?.aborted, true);
    assert.deepEqual(stopped.rows, []);
    assert.equal((await fx.service.state(PROJECT)).state, AiCheckState.Ready);
  });

  it("keeps the result and the creator's pick across a restart", async () => {
    const build = (clock: ReturnType<typeof heldClock>) => [
      door(AiDoor.Local, ["qwen3:8b", "llama3.2:3b"], fits, clock),
    ];
    const first = await check(build);
    await first.service.start(PROJECT, { localOnly: false });
    await first.service.settled(PROJECT);
    const picked = await first.service.recommend(PROJECT, LLAMA);
    assert.deepEqual(picked.recommended, LLAMA);
    const again = await check(build, { dir: first.dir });
    const state = await again.service.state(PROJECT);
    assert.equal(state.state, AiCheckState.Done);
    assert.deepEqual(state.recommended, LLAMA);
    assert.equal(state.rows.length, 2);
    assert.ok(state.checkedAt);
    await assert.rejects(again.service.recommend(PROJECT, HAIKU), /not a model the check ran/);
    assert.equal((await again.service.recommend(PROJECT, null)).recommended, null);
  });

  const files: Array<[string, string]> = [
    ["not JSON", "{"],
    ["another version", JSON.stringify({ v: 4 })],
    ["a row that does not add up", JSON.stringify({ v: 1, rows: [{ fitted: 9, moments: 1 }], recommended: null })],
  ];
  for (const [name, text] of files)
    it(`reads a saved result that is ${name} as never checked`, async () => {
      const fx = await check((clock) => [door(AiDoor.Local, ["qwen3:8b"], fits, clock)]);
      await mkdir(path.dirname(checksFile(fx.dir, PROJECT)), { recursive: true });
      await writeFile(checksFile(fx.dir, PROJECT), text);
      assert.equal((await fx.service.state(PROJECT)).state, AiCheckState.Ready);
    });

  it("answers the Report its row for a game in the library only", async () => {
    const fx = await check((clock) => [door(AiDoor.Local, ["qwen3:8b"], fits, clock)]);
    await fx.service.start(PROJECT, { localOnly: false });
    await fx.service.settled(PROJECT);
    assert.equal((await fx.service.rowFor(createGameKey(PROJECT), QWEN))?.model.model, QWEN.model);
    assert.equal(await fx.service.rowFor(createGameKey(PROJECT), HAIKU), null);
    assert.equal(await fx.service.rowFor(playGameKey("p1"), QWEN), null);
  });
});

describe("what Publish shows", () => {
  it("names the playtest's model, with no fit or cost, before any check", async () => {
    const fx = await check((clock) => [door(AiDoor.Local, ["qwen3:8b"], fits, clock)], {
      creatorShareBps: async () => 1_000,
    });
    const facts = await fx.service.publishFacts(PROJECT);
    assert.deepEqual(facts, {
      project: PROJECT,
      playtested: true,
      playtestModel: QWEN,
      check: await fx.service.state(PROJECT),
      bestWith: QWEN,
      fits: null,
      cost: null,
      creatorShareBps: 1_000,
    });
  });

  it("names the best fit, free first, then the creator's pick with its cost for players", async () => {
    const fx = await check(
      (clock) => [
        door(AiDoor.Local, ["llama3.2:3b"], fits, clock),
        door(AiDoor.Byok, [HAIKU.model], fits, clock, { cost: 900 }),
      ],
      { playerCostMicros: () => 800 },
    );
    await fx.service.start(PROJECT, { localOnly: false });
    await fx.service.settled(PROJECT);
    const best = await fx.service.publishFacts(PROJECT);
    assert.deepEqual(best.bestWith, LLAMA);
    assert.deepEqual(best.fits, { fitted: 2, of: 2 });
    assert.equal(best.cost, AiCostLevel.Free);
    await fx.service.recommend(PROJECT, HAIKU);
    const picked = await fx.service.publishFacts(PROJECT);
    assert.deepEqual(picked.bestWith, HAIKU);
    assert.equal(picked.cost, AiCostLevel.Low);
  });

  it("has no playtest model for a game never playtested with AI", async () => {
    const fx = await check((clock) => [door(AiDoor.Local, ["qwen3:8b"], fits, clock)], { momentCount: 0 });
    const facts = await fx.service.publishFacts(PROJECT);
    assert.deepEqual([facts.playtested, facts.playtestModel, facts.bestWith], [false, null, null]);
  });
});
