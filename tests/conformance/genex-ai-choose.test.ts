/**
 * Which lane `genex-ai` starts on, from where its page runs: Genex Desktop's Play, genex.games,
 * or Studio's preview with or without a hint on the shim tag. A hint is the page's own markup,
 * so a malformed one is ignored, and the platform lane is never a preview's to pick.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AiBridgeOp, AiErrorCode, GAME_AI_WIRE_VERSION } from "../../src/shared/game-ai.ts";
import { AI_ROUTE_PREFIX } from "../../src/shared/game-ai-bridge.ts";
import { AI_LANE_HINT_MAX_CHARS, AiLane, aiLaneHintAttribute } from "../../src/shared/game-ai-lane.ts";
import { GENEX_DESKTOP_BRIDGE_VERSION } from "../../src/shared/genex-desktop-bridge.ts";
import { tapeFile } from "../../src/shared/game-ai-tape.ts";
import { laneSource, type PageEnv } from "../../src/page/ai/lanes/choose.ts";
import { createRuntime } from "../../src/page/ai/runtime.ts";
import type { GameAi } from "../../src/page/ai/types.ts";
import { fakeFetch, type SeenRequest } from "../helpers/genex-ai-fakes.ts";

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

/** An embed SDK that holds no grant and answers nothing else. */
const quietSdk = () => ({
  getActiveSpendGrant: async () => null,
  requestSpendGrant: async () => ({ status: "canceled" }),
  stopSpendGrant: async () => null,
  generate: async () => ({ status: "failed", error: "generation_unavailable" }),
  generateStream: async () => ({ status: "failed" }),
  judge: async () => ({ status: "failed" }),
  getGenerationModels: async () => ({ models: [] }),
});

/** A page env: a scope, a hint, a fetch serving `routes`, and the connected embed SDK, counting each read of it. */
function env(
  options: { scope?: unknown; hint?: string | null; routes?: Record<string, (r: SeenRequest) => Response> } = {},
) {
  const files = fakeFetch(options.routes ?? {});
  const loads = { count: 0 };
  const page: PageEnv = {
    scope: options.scope ?? {},
    fetch: files.fetch,
    hint: () => options.hint ?? null,
    embedSdk: () => {
      loads.count += 1;
      return quietSdk();
    },
    session: () => "session-1",
  };
  return { page, seen: files.seen, loads };
}

async function started(page: PageEnv, sdk?: unknown): Promise<GameAi> {
  const ai = createRuntime(
    {},
    { lanes: laneSource(page, sdk ? { sdk } : {}), gesture: () => false, register: () => {} },
  );
  await ai.ready();
  return ai;
}

const helloOn = { [`${AI_ROUTE_PREFIX}${AiBridgeOp.Hello}`]: () => json({ v: GAME_AI_WIRE_VERSION, on: true }) };

describe("where a page starts", () => {
  it("in Genex Desktop's Play: main's lane, through the Play view's bridge", async () => {
    const requests: string[] = [];
    const ai = {
      request: async (op: string) => {
        requests.push(op);
        return op === AiBridgeOp.Hello ? { v: GAME_AI_WIRE_VERSION, on: true } : { view: null, code: null };
      },
      onDelta: () => () => {},
    };
    const scope = {
      __genexDesktop: { version: GENEX_DESKTOP_BRIDGE_VERSION, confirm: async () => ({ approved: false }), ai },
      __GENEX__: {},
    };
    const { page, seen } = env({ scope });
    const game = await started(page);
    assert.equal(game.status().lane, AiLane.Host);
    assert.deepEqual(requests, [AiBridgeOp.Hello, AiBridgeOp.BudgetActive]);
    assert.equal(seen.length, 0, "the route is never asked in Play");
  });

  it("on genex.games: the platform lane, through the embed SDK the page connected", async () => {
    const { page, loads } = env({ scope: { __GENEX__: { apiUrl: "https://api.genex.games" } } });
    const game = await started(page);
    assert.equal(game.status().lane, AiLane.Platform);
    assert.equal(loads.count, 1);
  });

  it("on genex.games with the game's own copy of the SDK: that copy, not the connected one", async () => {
    const { page, loads } = env({ scope: { __GENEX__: {} } });
    const game = await started(page, quietSdk());
    assert.equal(game.status().lane, AiLane.Platform);
    assert.equal(loads.count, 0);
  });

  it("is off when the page connected no embed SDK it can call", async () => {
    const { page } = env({ scope: { __GENEX__: {} } });
    page.embedSdk = () => ({ generate: () => null });
    const game = await started(page);
    assert.equal(game.status().lane, null);
    assert.equal(game.status().on, false);
    game.ask({ site: "a", prompt: "p", schema: { type: "boolean" } });
    await game.ready();
    assert.equal(game.drain()[0]?.code, AiErrorCode.Off);
  });

  it("in the preview with a tape hint: the demo's saved playtest", async () => {
    const tapeUrl = `/${tapeFile("walk")}`;
    const { page, seen } = env({
      hint: aiLaneHintAttribute({ lane: AiLane.Tape, tape: "walk" }),
      routes: { [tapeUrl]: () => new Response("") },
    });
    const game = await started(page);
    assert.equal(game.status().lane, AiLane.Tape);
    assert.equal(game.status().tape, "walk");
    assert.deepEqual(
      seen.map((request) => request.url),
      [tapeUrl],
    );
  });

  it("in the preview with a mock, off or host hint: that lane", async () => {
    for (const lane of [AiLane.Mock, AiLane.Off, AiLane.Host]) {
      const { page } = env({ hint: aiLaneHintAttribute({ lane, tape: null }), routes: helloOn });
      assert.equal((await started(page)).status().lane, lane);
    }
  });

  it("in the preview with no hint: main's route when it says AI is on, else off", async () => {
    assert.equal((await started(env({ routes: helloOn }).page)).status().lane, AiLane.Host);
    assert.equal((await started(env().page)).status().lane, AiLane.Off);
  });
});

describe("a hint on the shim tag is the page's own markup", () => {
  const ROWS: Array<[string, string]> = [
    ["not JSON", "{lane:tape"],
    ["the platform lane", JSON.stringify({ lane: AiLane.Platform, tape: null })],
    ["an unknown lane", JSON.stringify({ lane: "moon", tape: null })],
    ["an extra key", JSON.stringify({ lane: AiLane.Tape, tape: null, grant: "x" })],
    ["a tape name that climbs out", JSON.stringify({ lane: AiLane.Tape, tape: "../secrets" })],
    ["a tape name with a slash", JSON.stringify({ lane: AiLane.Tape, tape: "a/b" })],
    ["a prototype key", '{"lane":"tape","tape":null,"__proto__":{"x":1}}'],
    ["one past its length", JSON.stringify({ lane: AiLane.Tape, tape: "a".repeat(AI_LANE_HINT_MAX_CHARS) })],
  ];
  for (const [name, hint] of ROWS) {
    it(`is ignored when it is ${name}: the page asks main's route instead`, async () => {
      const { page, seen } = env({ hint, routes: helloOn });
      const game = await started(page);
      assert.equal(game.status().lane, AiLane.Host);
      assert.equal(seen[0]?.url, `${AI_ROUTE_PREFIX}${AiBridgeOp.Hello}`);
      assert.equal(
        seen.some((request) => request.url.includes("tapes")),
        false,
      );
    });
  }
});
