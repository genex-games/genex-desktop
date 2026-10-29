/**
 * Fakes for `genex-ai` (`src/page/ai`) tests: a fetch that serves a game's files and records every
 * request, tape lines keyed the way the page keys its calls, a lane source over any lane, and a
 * game that drains once per step.
 */
import { setImmediate as nextTurn } from "node:timers/promises";
import { AiOp, AiSource, AiTier } from "../../src/shared/game-ai.ts";
import { type AiMissedCall, TAPE_WIRE_VERSION, type TapeLine, tapeLineText } from "../../src/shared/game-ai-tape.ts";
import { callKeyNow } from "../../src/page/ai/sha256.ts";
import type { Lane } from "../../src/page/ai/lanes/lane.ts";
import { createRuntime, type RuntimeDeps } from "../../src/page/ai/runtime.ts";
import type { AiStatus, CreateAiOptions, GameAi } from "../../src/page/ai/types.ts";

/** One request the fake fetch saw. */
export interface SeenRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

/** A fetch answering from `routes` (path → response maker), recording every request; anything else is a 404. */
export function fakeFetch(routes: Record<string, (request: SeenRequest) => Response | Promise<Response>>) {
  const seen: SeenRequest[] = [];
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = typeof init?.body === "string" ? init.body : null;
    const request: SeenRequest = { url: input, method: init?.method ?? "GET", headers, body };
    seen.push(request);
    const route = routes[input];
    return route ? route(request) : new Response("not found", { status: 404 });
  };
  return { fetch, seen };
}

/** A tape line for a call as the page keys it. */
export function lineFor(
  call: { op?: AiOp; site: string; system?: string | null; prompt: string; schema: unknown; tier?: AiTier },
  value: unknown,
  options: { n?: number; latencyFrames?: number } = {},
): TapeLine {
  const op = call.op ?? AiOp.Ask;
  const key = callKeyNow({
    op,
    site: call.site,
    system: call.system ?? null,
    prompt: call.prompt,
    untrusted: {},
    memory: null,
    schema: call.schema,
    tier: call.tier ?? AiTier.Fast,
  });
  return {
    v: TAPE_WIRE_VERSION,
    key,
    n: options.n ?? 0,
    site: call.site,
    op,
    value,
    source: AiSource.Local,
    model: "fixture-model",
    latencyFrames: options.latencyFrames ?? 1,
    usage: null,
  };
}

/** A tape's text from its lines. */
export const tapeText = (lines: readonly TapeLine[]): string => lines.map(tapeLineText).join("");

/** The runtime over one lane, with the studio handle it registered and a switchable gesture. */
export function aiOn(lane: Lane, options?: CreateAiOptions, platform: (() => Promise<Lane>) | null = null) {
  const handle: {
    status: (() => AiStatus) | null;
    reset: ((seed: number) => void) | null;
    missed: (() => AiMissedCall[]) | null;
  } = {
    status: null,
    reset: null,
    missed: null,
  };
  const gesture = { active: false };
  const deps: RuntimeDeps = {
    lanes: { first: async () => lane, platform },
    gesture: () => gesture.active,
    register: (registered) => {
      handle.status = registered.status;
      handle.reset = registered.reset;
      handle.missed = registered.missed;
    },
  };
  const ai: GameAi = createRuntime(options, deps);
  return { ai, handle, gesture };
}

/** Let every promise the runtime started settle. */
export async function settled(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await nextTurn();
}
