/**
 * Play-time AI for the builder agent (`main/game-ai/harness-host.ts`, behind `harness-rpc/ai.ts`):
 * saved playtests of the build, replays of a demo under seeds on its tape, with AI off or with the
 * worst answers its shapes allow, a recording made on this Mac's models one missed call at a time,
 * a bench of one call site, and the model check on local models. Every model call is taken from the
 * run budget the host made (`createRunBudget`): nothing past its cap, no door but this Mac's, and a
 * reply's repair is a call of its own. A demo is played by a stand-in for the preview (the
 * `AiDemoPlayer` seam), which here is a small deterministic game reading the real tape on disk.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRunBudget } from "../../src/main/harness-rpc/ai.ts";
import {
  type AiDemoPlayer,
  type AiDemoResult,
  type AiDemoRun,
  budgetedDoor,
  createGameAiHarnessHost,
  type GameAiHarnessDeps,
} from "../../src/main/game-ai/harness-host.ts";
import { createGameAiQueue } from "../../src/main/game-ai/queue.ts";
import { createGameAiTapes } from "../../src/main/game-ai/tapes.ts";
import type { AiMoment } from "../../src/main/game-ai/moments.ts";
import type { AiDoorAnswer } from "../../src/main/game-ai/types.ts";
import {
  AiAuthority,
  AiDoor,
  AiErrorCode,
  AiOp,
  AiTier,
  type AiCallRequest,
  GAME_AI_WIRE_VERSION,
} from "../../src/shared/game-ai.ts";
import { AiCheckState, type AiCheckResult } from "../../src/shared/game-ai-check.ts";
import { AiLane } from "../../src/shared/game-ai-lane.ts";
import {
  AiReplayAnswers,
  callKey,
  callKeyInput,
  readTape,
  tapeFile,
  TAPE_WIRE_VERSION,
  tapeLineText,
} from "../../src/shared/game-ai-tape.ts";
import { heldClock, LOCAL_QWEN, scriptedDoor, type ScriptedRun } from "../helpers/game-ai-fakes.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PROJECT = "Crowns";
const DEMO = "turn-three";
const SCHEMA = {
  type: "object",
  properties: { move: { type: "string" } },
  required: ["move"],
  additionalProperties: false,
};

/** The game's call on turn `turn`, its prompt carrying what the model said the turn before. */
function turnCall(turn: number, said: string): AiCallRequest {
  return {
    v: GAME_AI_WIRE_VERSION,
    op: AiOp.Ask,
    site: "turn.resolve",
    ticket: `tk0-${String(turn + 1).padStart(6, "0")}`,
    grantId: "ungranted",
    system: "You narrate a 1444 Europe.",
    prompt: `Turn ${turn}. Last: ${said}`,
    untrusted: {},
    memory: null,
    schema: SCHEMA,
    tier: AiTier.Fast,
    authority: AiAuthority.Local,
    maxOutputTokens: 120,
    stream: false,
  };
}

const answerOf = (move: string): AiDoorAnswer => ({
  text: JSON.stringify({ move }),
  model: "qwen3:8b",
  usage: { inputTokens: 200, outputTokens: 12 },
  costMicros: 0,
});

/**
 * A three-turn game as the preview would play it: on the tape lane each turn's call is answered by
 * the tape's line for it, and the first one the tape lacks is a miss that ends the play (the game
 * plays its fallback from there); on the off and edge lanes every call is answered at once.
 */
function threeTurnGame(
  folder: () => Promise<string>,
  options: { digestOf?: (run: AiDemoRun, n: number) => string } = {},
) {
  const plays: AiDemoRun[] = [];
  const tapes = createGameAiTapes();
  const player: AiDemoPlayer = {
    async play(run): Promise<AiDemoResult> {
      plays.push(run);
      const nth = plays.filter((p) => p.seed === run.seed && p.lane.lane === run.lane.lane).length;
      const digest = options.digestOf?.(run, nth) ?? `seed-${run.seed}-${run.lane.lane}`;
      if (run.lane.lane !== AiLane.Tape) {
        return {
          ended: true,
          digests: [digest],
          status: { misses: 0, fallbacks: 0, pending: 0, refused: {} },
          missed: [],
          consoleErrors: 0,
        };
      }
      const lines = await tapes.read(await folder(), DEMO).catch(() => []);
      let said = "start";
      for (let turn = 0; turn < 3; turn += 1) {
        const request = turnCall(turn, said);
        const key = await callKey(callKeyInput(request));
        const line = lines.find((row) => row.key === key && row.n === 0);
        if (!line) {
          return {
            ended: true,
            digests: [digest],
            status: { misses: 1, fallbacks: 1, pending: 0, refused: { [AiErrorCode.Unrecorded]: 1 } },
            missed: [{ key, n: 0, request }],
            consoleErrors: 0,
          };
        }
        said = (line.value as { move: string }).move;
      }
      return {
        ended: true,
        digests: [digest],
        status: { misses: 0, fallbacks: 0, pending: 0, refused: {} },
        missed: [],
        consoleErrors: 0,
      };
    },
  };
  return { player, plays };
}

async function setup(
  options: {
    local?: ScriptedRun[];
    localReady?: boolean;
    moments?: AiMoment[];
    creatorChecking?: boolean;
    digestOf?: (run: AiDemoRun, n: number) => string;
  } = {},
) {
  const root = await tmpDir("game-ai-harness-");
  const game = path.join(root, PROJECT);
  const build = path.join(root, "scratch-copy");
  await mkdir(game, { recursive: true });
  await mkdir(build, { recursive: true });
  const local = scriptedDoor(AiDoor.Local, options.local ?? [], {
    models: [LOCAL_QWEN],
    ready: { ready: options.localReady ?? true },
  });
  const folderOf = async (project: string, buildRoot: string | null) => {
    if (project !== PROJECT) throw new Error("not a game in the library");
    return buildRoot ?? game;
  };
  const game3 = threeTurnGame(() => Promise.resolve(game), {
    ...(options.digestOf ? { digestOf: options.digestOf } : {}),
  });
  const checks: Array<{ project: string; localOnly: boolean; doors: AiDoor[] }> = [];
  const result = (state: AiCheckState): AiCheckResult => ({
    project: PROJECT,
    state,
    moments: 3,
    progress: null,
    rows: [],
    recommended: null,
    checkedAt: null,
  });
  const deps: GameAiHarnessDeps = {
    clock: heldClock(),
    folderOf,
    tapes: createGameAiTapes(),
    player: game3.player,
    local,
    queue: createGameAiQueue({ slotWaitMs: 100, buildWaitMs: 50 }),
    moments: { list: async () => options.moments ?? [] },
    checkOn: (doors) => ({
      start: async (project, { localOnly }) => {
        checks.push({ project, localOnly, doors: [...doors.keys()] });
        // The check runs its calls on the doors it was given: the run budget's local door.
        await doors.get(AiDoor.Local)?.run(
          {
            game: `create:${project}`,
            request: turnCall(0, "check"),
            model: LOCAL_QWEN,
            purpose: "game",
            repair: null,
          },
          new AbortController().signal,
        );
        return result(AiCheckState.Checking);
      },
      settled: async () => result(AiCheckState.Ready),
    }),
    creatorCheck: { state: async () => result(options.creatorChecking ? AiCheckState.Checking : AiCheckState.Ready) },
  };
  return { host: createGameAiHarnessHost(deps), local, game, build, plays: game3.plays, checks };
}

async function writeTape(folder: string, lines: Parameters<typeof tapeLineText>[0][]): Promise<void> {
  await mkdir(path.join(folder, "ai", "tapes"), { recursive: true });
  await writeFile(path.join(folder, tapeFile(DEMO)), lines.map(tapeLineText).join(""));
}

/** The tape a recording of the three-turn game makes when the model answers march, hold, fall back. */
async function fullTape() {
  const moves = ["march", "hold", "fall back"];
  let said = "start";
  const lines = [];
  for (let turn = 0; turn < 3; turn += 1) {
    const request = turnCall(turn, said);
    lines.push({
      v: TAPE_WIRE_VERSION,
      key: await callKey(callKeyInput(request)),
      n: 0,
      site: request.site,
      op: AiOp.Ask,
      value: { move: moves[turn] },
      source: AiDoor.Local,
      model: "qwen3:8b",
      latencyFrames: 1,
      usage: { inputTokens: 200, outputTokens: 12 },
    } as const);
    said = moves[turn] ?? "";
  }
  return lines;
}

describe("the harness's saved playtests and replays", () => {
  it("lists the playtests of the build the call names", async () => {
    const h = await setup();
    await writeTape(h.build, await fullTape());
    const [summary] = await h.host.tapes(PROJECT, { root: h.build });
    assert.equal(summary?.name, DEMO);
    assert.equal(summary?.calls, 3);
    assert.deepEqual(await h.host.tapes(PROJECT, { root: null }), [], "the game's own folder has none");
  });

  it("replays a demo twice under each seed on its tape, and reports what it found", async () => {
    const h = await setup();
    await writeTape(h.game, await fullTape());
    const result = await h.host.replay(PROJECT, DEMO, [1, 2, 3], { root: null, answers: AiReplayAnswers.Tape });
    assert.equal(result.demo, DEMO);
    assert.equal(result.deterministic, true);
    assert.deepEqual(result.stateDigests, [["seed-1-tape"], ["seed-2-tape"], ["seed-3-tape"]]);
    assert.equal(result.misses, 0);
    assert.equal(result.rejected, 0);
    assert.equal(result.settled, true);
    assert.equal(result.answers, AiReplayAnswers.Tape);
    assert.equal(h.plays.length, 6, "each seed played twice");
    assert.ok(h.plays.every((play) => play.lane.lane === AiLane.Tape && play.lane.tape === DEMO));
    assert.equal(h.local.runs.length, 0, "a replay never reaches a model");
  });

  it("says a replay is not deterministic when a seed plays different frames on its two runs", async () => {
    const h = await setup({ digestOf: (run, n) => (run.seed === 2 && n === 2 ? "drifted" : `seed-${run.seed}`) });
    await writeTape(h.game, await fullTape());
    const result = await h.host.replay(PROJECT, DEMO, [1, 2], { root: null, answers: AiReplayAnswers.Tape });
    assert.equal(result.deterministic, false);
  });

  it("counts what the tape lacked, the fallbacks and the refusals, over every seed", async () => {
    const h = await setup();
    await writeTape(h.game, (await fullTape()).slice(0, 1));
    const result = await h.host.replay(PROJECT, DEMO, [1, 2], { root: null, answers: AiReplayAnswers.Tape });
    assert.equal(result.misses, 2);
    assert.equal(result.fallbacks, 2);
    assert.deepEqual(result.refused, { [AiErrorCode.Unrecorded]: 2 });
  });

  it("replays with AI off and with the worst answers on their own lanes, with no tape needed", async () => {
    const h = await setup();
    const none = await h.host.replay(PROJECT, DEMO, [1], { root: null, answers: AiReplayAnswers.None });
    assert.equal(none.answers, AiReplayAnswers.None);
    const edge = await h.host.replay(PROJECT, DEMO, [1, 2], { root: null, answers: AiReplayAnswers.Edge });
    assert.equal(edge.answers, AiReplayAnswers.Edge);
    assert.deepEqual([...new Set(h.plays.map((play) => play.lane.lane))], [AiLane.Off, AiLane.Edge]);
    assert.ok(h.plays.every((play) => play.lane.tape === null));
  });

  it("refuses a tape replay of a demo that has no saved playtest, before anything plays", async () => {
    const h = await setup();
    await assert.rejects(h.host.replay(PROJECT, DEMO, [1], { root: null, answers: AiReplayAnswers.Tape }));
    assert.equal(h.plays.length, 0);
  });

  it("refuses a demo name that is not one, before anything is read or played", async () => {
    const h = await setup();
    for (const demo of ["../x", "Turn Three", "", "a/b"]) {
      await assert.rejects(h.host.replay(PROJECT, demo, [1], { root: null, answers: AiReplayAnswers.None }), demo);
      await assert.rejects(h.host.record(PROJECT, demo, 1, { root: null, budget: createRunBudget(5).budget }), demo);
    }
    assert.equal(h.plays.length, 0);
    assert.equal(h.local.runs.length, 0);
  });
});

describe("the harness's recording", () => {
  it("answers each missed call on this Mac's model and plays again until the demo misses nothing", async () => {
    const h = await setup({ local: [answerOf("march"), answerOf("hold"), answerOf("fall back")] });
    const owned = createRunBudget(10);
    const result = await h.host.record(PROJECT, DEMO, 7, { root: null, budget: owned.budget });
    assert.deepEqual(result, { demo: DEMO, file: tapeFile(DEMO), calls: 3, refused: 0 });
    const tape = readTape(await readFile(path.join(h.game, tapeFile(DEMO)), "utf8"));
    assert.deepEqual(
      tape.lines.map((line) => line.value),
      [{ move: "march" }, { move: "hold" }, { move: "fall back" }],
    );
    assert.deepEqual(tape.lines, await fullTape());
    assert.equal(owned.budget.used(), 3);
    assert.equal(h.plays.length, 4, "one play per call, and one that misses nothing");
    assert.ok(h.plays.every((play) => play.seed === 7 && play.lane.lane === AiLane.Tape));
    assert.ok(h.local.runs.every((run) => run.model.door === AiDoor.Local));
  });

  it("stops at the budget's cap, keeps what it recorded and counts the call it could not make", async () => {
    const h = await setup({ local: [answerOf("march"), answerOf("hold"), answerOf("fall back")] });
    const owned = createRunBudget(2);
    const result = await h.host.record(PROJECT, DEMO, 1, { root: null, budget: owned.budget });
    assert.equal(result.calls, 2);
    assert.equal(result.refused, 1);
    assert.equal(h.local.runs.length, 2, "nothing past the cap reached the model");
    const tape = readTape(await readFile(path.join(h.game, tapeFile(DEMO)), "utf8"));
    assert.equal(tape.lines.length, 2);
  });

  it("counts a reply's one repair as a call of its own", async () => {
    const bad: AiDoorAnswer = { text: "Burgundy marches.", model: "qwen3:8b", usage: null, costMicros: 0 };
    const h = await setup({ local: [bad, answerOf("march"), answerOf("hold"), answerOf("fall back")] });
    const owned = createRunBudget(10);
    const result = await h.host.record(PROJECT, DEMO, 1, { root: null, budget: owned.budget });
    assert.equal(result.calls, 3);
    assert.equal(owned.budget.used(), 4);
    assert.equal(h.local.runs[1]?.repair?.previous, bad.text);
  });

  it("keeps the playtest the game had when nothing could be recorded", async () => {
    const h = await setup({ localReady: false });
    const before = await fullTape();
    await writeTape(h.game, before.slice(0, 1));
    const kept = await readFile(path.join(h.game, tapeFile(DEMO)), "utf8");
    const result = await h.host.record(PROJECT, DEMO, 1, { root: null, budget: createRunBudget(5).budget });
    assert.equal(result.calls, 0);
    assert.equal(result.refused, 1);
    assert.equal(await readFile(path.join(h.game, tapeFile(DEMO)), "utf8"), kept);
  });

  it("records into the build the call names, never the game's own folder", async () => {
    const h = await setup({ local: [answerOf("march"), answerOf("hold"), answerOf("fall back")] });
    await h.host.record(PROJECT, DEMO, 1, { root: h.build, budget: createRunBudget(10).budget });
    assert.ok((await readFile(path.join(h.build, tapeFile(DEMO)), "utf8")).length > 0);
    await assert.rejects(readFile(path.join(h.game, tapeFile(DEMO)), "utf8"));
  });
});

describe("the run budget's doors", () => {
  it("takes one slot per call, refuses past the cap and any door but its own, and frees the slot when the call ends", async () => {
    const owned = createRunBudget(2);
    const local = scriptedDoor(AiDoor.Local, [answerOf("a"), answerOf("b"), answerOf("c")]);
    const door = budgetedDoor(local, owned.budget);
    const call = {
      game: "create:Crowns" as const,
      request: turnCall(0, "x"),
      model: LOCAL_QWEN,
      purpose: "game" as const,
      repair: null,
    };
    await door.run(call, new AbortController().signal);
    await door.run(call, new AbortController().signal);
    await assert.rejects(door.run(call, new AbortController().signal));
    assert.equal(local.runs.length, 2);
    const byok = budgetedDoor(scriptedDoor(AiDoor.Byok), createRunBudget(5).budget);
    await assert.rejects(
      byok.run({ ...call, model: { ...LOCAL_QWEN, door: AiDoor.Byok } }, new AbortController().signal),
    );
    const closing = createRunBudget(5);
    closing.close();
    await assert.rejects(budgetedDoor(local, closing.budget).run(call, new AbortController().signal));
  });
});

describe("the harness's bench and model check", () => {
  const moment = (prompt: string, at: string): AiMoment => ({
    key: "k".repeat(64),
    request: { ...turnCall(0, prompt), site: "turn.resolve" },
    value: { move: "x" },
    model: LOCAL_QWEN,
    at,
  });

  it("samples the newest saved moment of a site on this Mac's model", async () => {
    const bad: AiDoorAnswer = {
      text: "nope",
      model: "qwen3:8b",
      usage: { inputTokens: 1, outputTokens: 1 },
      costMicros: 0,
    };
    const h = await setup({
      local: [answerOf("a"), bad, bad, answerOf("c")],
      moments: [moment("old", "2026-10-19T10:00:00.000Z"), moment("new", "2026-10-20T10:00:00.000Z")],
    });
    const owned = createRunBudget(6);
    const result = await h.host.bench(PROJECT, "turn.resolve", 3, { root: null, budget: owned.budget });
    assert.equal(result.site, "turn.resolve");
    assert.deepEqual(result.model, LOCAL_QWEN);
    assert.equal(result.samples, 3);
    assert.equal(result.fitted, 2, "the sample whose reply and repair both failed did not fit");
    assert.equal(result.medianInputTokens, 200);
    assert.ok(h.local.runs.every((run) => run.request.prompt.includes("new")));
  });

  it("measures nothing for a site no saved moment has, or with no model on this Mac", async () => {
    const h = await setup({ moments: [] });
    const none = await h.host.bench(PROJECT, "npc.reply", 3, { root: null, budget: createRunBudget(6).budget });
    assert.deepEqual(none, {
      site: "npc.reply",
      model: null,
      samples: 0,
      fitted: 0,
      medianLatencyMs: null,
      medianInputTokens: null,
      medianOutputTokens: null,
    });
    const off = await setup({ localReady: false, moments: [moment("x", "2026-10-20T10:00:00.000Z")] });
    const result = await off.host.bench(PROJECT, "turn.resolve", 3, { root: null, budget: createRunBudget(6).budget });
    assert.equal(result.model, null);
    assert.equal(off.local.runs.length, 0);
  });

  it("checks on this Mac's models only, through the run budget's door", async () => {
    const h = await setup({ local: [answerOf("a")] });
    const owned = createRunBudget(4);
    const result = await h.host.modelCheck(PROJECT, { localOnly: true, budget: owned.budget });
    assert.equal(result.state, AiCheckState.Ready);
    assert.deepEqual(h.checks, [{ project: PROJECT, localOnly: true, doors: [AiDoor.Local] }]);
    assert.equal(owned.budget.used(), 1);
  });

  it("answers with the creator's own check while it runs, starting nothing", async () => {
    const h = await setup({ creatorChecking: true });
    const result = await h.host.modelCheck(PROJECT, { localOnly: true, budget: createRunBudget(4).budget });
    assert.equal(result.state, AiCheckState.Checking);
    assert.deepEqual(h.checks, []);
  });
});
