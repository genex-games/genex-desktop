/**
 * `genex-ai`'s host lane: main on this Mac, over the Create Live route (a fake fetch standing in
 * for main's route) and over the Play view's `window.__genexDesktop.ai` (a fake bridge). The lane
 * sends exactly the op's body; main's answer crosses a bridge the game shares, so every malformed
 * answer becomes a typed failure and never a value.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AiAuthority,
  AiBridgeOp,
  AiDoor,
  AiErrorCode,
  AiGrantStatus,
  AiProvenance,
  AiRequirement,
  AiSource,
  AiTier,
  GAME_AI_WIRE_VERSION,
} from "../../src/shared/game-ai.ts";
import { AI_ROUTE_PREFIX, AiRouteEvent } from "../../src/shared/game-ai-bridge.ts";
import { AiLane } from "../../src/shared/game-ai-lane.ts";
import { GENEX_DESKTOP_BRIDGE_VERSION } from "../../src/shared/genex-desktop-bridge.ts";
import {
  desktopAiOf,
  desktopTransport,
  HOST_MAX_ANSWER_BYTES,
  hostLane,
  routeTransport,
} from "../../src/page/ai/lanes/host.ts";
import { s } from "../../src/page/ai/schema.ts";
import type { AiResult, GameAi } from "../../src/page/ai/types.ts";
import { aiOn, fakeFetch, type SeenRequest, settled } from "../helpers/genex-ai-fakes.ts";

const Line = s.object({ line: s.string({ max: 40 }) });
const GRANT = {
  id: "grant-0001",
  status: AiGrantStatus.Active,
  door: AiDoor.Local,
  spentMicros: 0,
  planUsedPercent: null,
  planResetsAt: null,
};

type Handler = (body: unknown, request: SeenRequest) => unknown;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A stand-in for main's Create route: one handler per op, answering JSON (or a whole Response). */
function route(handlers: Partial<Record<AiBridgeOp, Handler>>) {
  const routes = Object.fromEntries(
    Object.values(AiBridgeOp).map((op) => [
      `${AI_ROUTE_PREFIX}${op}`,
      async (request: SeenRequest) => {
        const handler = handlers[op];
        if (!handler) return json({ v: GAME_AI_WIRE_VERSION, code: AiErrorCode.BadRequest }, 404);
        const answer = await handler(JSON.parse(request.body ?? "null"), request);
        return answer instanceof Response ? answer : json(answer);
      },
    ]),
  );
  return fakeFetch(routes);
}

const on: Handler = () => ({ v: GAME_AI_WIRE_VERSION, on: true });
const granted: Handler = () => ({ view: GRANT, code: null });

/** A call's answer as main sends it. */
const answered = (ticket: string, value: unknown, extra: Record<string, unknown> = {}) => ({
  v: GAME_AI_WIRE_VERSION,
  ok: true,
  ticket,
  value,
  source: AiSource.Local,
  provenance: AiProvenance.Unverified,
  latencyMs: 120,
  cached: false,
  ...extra,
});

const ticketOf = (body: unknown): string => (body as { ticket: string }).ticket;

/** Drain until a result arrives (at most `frames` drains, letting the fake route answer between them). */
async function nextResult(ai: GameAi, frames = 5): Promise<AiResult | undefined> {
  for (let frame = 0; frame < frames; frame += 1) {
    await settled();
    const [result] = ai.drain();
    if (result) return result;
  }
  return undefined;
}

describe("the host lane over the Create route", () => {
  it("opens with main's hello and the grant the game holds, sending exactly each op's body", async () => {
    const server = route({ [AiBridgeOp.Hello]: on, [AiBridgeOp.BudgetActive]: granted });
    const { ai } = aiOn(hostLane(routeTransport(server.fetch)));
    await ai.ready();
    assert.equal(ai.status().lane, AiLane.Host);
    assert.equal(ai.status().on, true);
    assert.equal(ai.status().door, AiDoor.Local);
    for (const request of server.seen) {
      assert.equal(request.method, "POST");
      assert.equal(request.headers["content-type"], "application/json");
      assert.equal(request.body, "null");
    }
    assert.deepEqual(
      server.seen.map((request) => request.url),
      [`${AI_ROUTE_PREFIX}${AiBridgeOp.Hello}`, `${AI_ROUTE_PREFIX}${AiBridgeOp.BudgetActive}`],
    );
  });

  it("is off, and asks no grant, when main says AI is off here", async () => {
    const server = route({ [AiBridgeOp.Hello]: () => ({ v: GAME_AI_WIRE_VERSION, on: false }) });
    const { ai } = aiOn(hostLane(routeTransport(server.fetch)));
    await ai.ready();
    assert.equal(ai.status().on, false);
    assert.equal(server.seen.length, 1);
  });

  it("sends the compiled call, and releases main's answer on the drain after it arrives", async () => {
    let sent: unknown = null;
    const server = route({
      [AiBridgeOp.Hello]: on,
      [AiBridgeOp.BudgetActive]: granted,
      [AiBridgeOp.Call]: (body) => {
        sent = body;
        return answered(ticketOf(body), { line: "hello" });
      },
    });
    const { ai } = aiOn(hostLane(routeTransport(server.fetch)));
    await ai.ready();
    const ticket = ai.ask({ site: "npc.reply", prompt: "Greet.", schema: Line, untrusted: { name: "Ana" } });
    const result = await nextResult(ai);
    assert.equal(result?.ok, true);
    assert.deepEqual(result?.value, { line: "hello" });
    assert.equal(result?.provenance, AiProvenance.Unverified);
    assert.equal(ticket.result(), result);
    assert.equal((sent as { grantId: string }).grantId, GRANT.id);
    assert.deepEqual((sent as { untrusted: unknown }).untrusted, { name: "Ana" });
  });

  it("streams a say answer's text as it comes, then releases the reply", async () => {
    const server = route({
      [AiBridgeOp.Hello]: on,
      [AiBridgeOp.BudgetActive]: granted,
      [AiBridgeOp.Call]: (body, request) => {
        assert.equal(request.headers.accept, "text/event-stream");
        const ticket = ticketOf(body);
        const events = [
          `event: ${AiRouteEvent.Delta}\ndata: ${JSON.stringify({ text: "Hel" })}\n\n`,
          `event: ${AiRouteEvent.Delta}\ndata: ${JSON.stringify({ text: "Hello" })}\n\n`,
          `event: ${AiRouteEvent.Reply}\ndata: ${JSON.stringify(answered(ticket, "Hello there"))}\n\n`,
        ];
        return new Response(events.join(""), { headers: { "content-type": "text/event-stream; charset=utf-8" } });
      },
    });
    const { ai } = aiOn(hostLane(routeTransport(server.fetch)));
    await ai.ready();
    const ticket = ai.say({ site: "npc.line", prompt: "Greet." });
    assert.equal(ticket.partial(), null);
    const result = await nextResult(ai);
    assert.equal(result?.value, "Hello there");
    assert.equal(ticket.partial(), "Hello");
  });

  it("tells main to cancel a call the game canceled", async () => {
    const cancels: unknown[] = [];
    const server = route({
      [AiBridgeOp.Hello]: on,
      [AiBridgeOp.BudgetActive]: granted,
      [AiBridgeOp.Call]: () => new Promise<never>(() => {}),
      [AiBridgeOp.Cancel]: (body) => {
        cancels.push(body);
        return { canceled: true };
      },
    });
    const { ai } = aiOn(hostLane(routeTransport(server.fetch)));
    await ai.ready();
    const ticket = ai.ask({ site: "npc.reply", prompt: "Greet.", schema: Line });
    await settled();
    assert.equal(ticket.cancel(), true);
    await settled();
    assert.deepEqual(cancels, [{ ticket: ticket.id }]);
    assert.equal((await nextResult(ai))?.code, AiErrorCode.Canceled);
  });

  it("asks main for a grant inside a gesture, with the game's requirement and tiers", async () => {
    const asked: unknown[] = [];
    const server = route({
      [AiBridgeOp.Hello]: on,
      [AiBridgeOp.BudgetActive]: () => ({ view: null, code: null }),
      [AiBridgeOp.BudgetRequest]: (body) => {
        asked.push(body);
        return { view: { ...GRANT, door: AiDoor.Byok }, code: null };
      },
      [AiBridgeOp.BudgetStop]: () => ({ stopped: true }),
    });
    const { ai, gesture } = aiOn(hostLane(routeTransport(server.fetch)), { requires: AiRequirement.Ai });
    await ai.ready();
    gesture.active = true;
    const view = await ai.requestBudget({ tiers: [AiTier.Smart] });
    assert.equal(view?.door, AiDoor.Byok);
    assert.deepEqual(asked, [{ v: GAME_AI_WIRE_VERSION, requires: AiRequirement.Ai, tiers: [AiTier.Smart] }]);
    await ai.stopBudget();
    assert.equal(ai.status().door, null);
  });

  it("retries an AI-only game's blocked call once, when the person gives it a grant", async () => {
    let calls = 0;
    const server = route({
      [AiBridgeOp.Hello]: on,
      [AiBridgeOp.BudgetActive]: () => ({ view: null, code: null }),
      [AiBridgeOp.BudgetRequest]: granted,
      [AiBridgeOp.Call]: (body) => {
        calls += 1;
        if (calls === 1)
          return {
            v: GAME_AI_WIRE_VERSION,
            ok: false,
            ticket: ticketOf(body),
            code: AiErrorCode.ConsentRequired,
            retryAfterMs: null,
          };
        return answered(ticketOf(body), { line: "back" });
      },
    });
    const { ai, gesture } = aiOn(hostLane(routeTransport(server.fetch)), { requires: AiRequirement.Ai });
    await ai.ready();
    ai.ask({ site: "npc.reply", prompt: "Greet.", schema: Line });
    assert.equal((await nextResult(ai))?.code, AiErrorCode.ConsentRequired);
    assert.equal(ai.status().needsAi, AiErrorCode.ConsentRequired);
    gesture.active = true;
    await ai.requestBudget();
    const retried = await nextResult(ai);
    assert.deepEqual(retried?.value, { line: "back" });
    assert.equal(ai.status().needsAi, null);
    assert.equal(calls, 2);
  });
});

describe("main's answer is untrusted on the page", () => {
  const ticketed =
    (make: (ticket: string) => unknown): Handler =>
    (body) =>
      make(ticketOf(body));
  const ROWS: Array<[string, Handler, AiErrorCode]> = [
    ["an answer for another ticket", () => answered("tk9-000009", { line: "x" }), AiErrorCode.Provider],
    ["another wire version", ticketed((t) => ({ ...answered(t, { line: "x" }), v: 2 })), AiErrorCode.Provider],
    ["no ok", ticketed((t) => ({ ...answered(t, { line: "x" }), ok: "yes" })), AiErrorCode.Provider],
    ["an unknown source", ticketed((t) => answered(t, { line: "x" }, { source: "moon" })), AiErrorCode.Provider],
    ["a negative latency", ticketed((t) => answered(t, { line: "x" }, { latencyMs: -1 })), AiErrorCode.Provider],
    ["no value", ticketed((t) => answered(t, undefined)), AiErrorCode.Provider],
    [
      "a refusal with an unknown code",
      ticketed((t) => ({ v: 1, ok: false, ticket: t, code: "nope", retryAfterMs: null })),
      AiErrorCode.Provider,
    ],
    ["a value outside the call's schema", ticketed((t) => answered(t, { line: 5 })), AiErrorCode.InvalidOutput],
    [
      "a value with keys the schema closes",
      ticketed((t) => answered(t, { line: "x", extra: 1 })),
      AiErrorCode.InvalidOutput,
    ],
    [
      "a body that is not JSON",
      () => new Response("{nope", { headers: { "content-type": "application/json" } }),
      AiErrorCode.Provider,
    ],
    ["a body past its cap", () => new Response("x".repeat(HOST_MAX_ANSWER_BYTES + 1)), AiErrorCode.Provider],
    ["a refusal status with its code", () => json({ v: 1, code: AiErrorCode.TooLarge }, 413), AiErrorCode.TooLarge],
    ["a refusal status with no body", () => new Response(null, { status: 500 }), AiErrorCode.DoorUnavailable],
    [
      "a stream that ends with no reply",
      () =>
        new Response(`event: ${AiRouteEvent.Delta}\ndata: {"text":"a"}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        }),
      AiErrorCode.Provider,
    ],
    [
      "a stream whose reply is for another ticket",
      () =>
        new Response(
          `event: ${AiRouteEvent.Reply}\ndata: ${JSON.stringify(answered("tk9-000009", { line: "x" }))}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
      AiErrorCode.Provider,
    ],
  ];
  for (const [name, handler, code] of ROWS) {
    it(`turns ${name} into ${code}`, async () => {
      const server = route({ [AiBridgeOp.Hello]: on, [AiBridgeOp.BudgetActive]: granted, [AiBridgeOp.Call]: handler });
      const { ai } = aiOn(hostLane(routeTransport(server.fetch)));
      await ai.ready();
      ai.ask({ site: "npc.reply", prompt: "Greet.", schema: Line, fallback: { line: "..." } });
      const result = await nextResult(ai);
      assert.equal(result?.ok, false);
      assert.equal(result?.code, code);
      assert.deepEqual(result?.value, { line: "..." });
    });
  }

  it("refuses a shared answer from a door that is not verified", async () => {
    const server = route({
      [AiBridgeOp.Hello]: on,
      [AiBridgeOp.BudgetActive]: granted,
      [AiBridgeOp.Call]: (body) => answered(ticketOf(body), { line: "x" }),
    });
    const { ai } = aiOn(hostLane(routeTransport(server.fetch)));
    await ai.ready();
    ai.ask({ site: "board.post", prompt: "Post.", schema: Line, authority: AiAuthority.Shared });
    assert.equal((await nextResult(ai))?.code, AiErrorCode.NeedsVerified);
  });

  it("is unreachable, not broken, when the route cannot be fetched", async () => {
    const fetch = async () => {
      throw new TypeError("network");
    };
    const { ai } = aiOn(hostLane(routeTransport(fetch)));
    await ai.ready();
    assert.equal(ai.status().on, false);
    ai.ask({ site: "npc.reply", prompt: "Greet.", schema: Line });
    assert.equal((await nextResult(ai))?.code, AiErrorCode.DoorUnavailable);
  });

  it("reads a grant that is not one as no grant", async () => {
    for (const view of [
      { ...GRANT, id: "short" },
      { ...GRANT, door: "moon" },
      { ...GRANT, spentMicros: -1 },
      "grant",
    ]) {
      const server = route({ [AiBridgeOp.Hello]: on, [AiBridgeOp.BudgetActive]: () => ({ view, code: null }) });
      const { ai } = aiOn(hostLane(routeTransport(server.fetch)));
      await ai.ready();
      assert.equal(ai.status().door, null, JSON.stringify(view));
      assert.equal(ai.status().refused[AiErrorCode.DoorUnavailable], 1);
    }
  });
});

/** A fake `window` with the Play view's bridge installed. */
function playWindow(ai: unknown, version: unknown = GENEX_DESKTOP_BRIDGE_VERSION) {
  return { __genexDesktop: { version, confirm: async () => ({ approved: false }), ai } };
}

describe("the host lane in Play", () => {
  it("finds the Play view's bridge, and nothing that is not one", () => {
    const ai = { request: async () => null, onDelta: () => () => {} };
    assert.notEqual(desktopAiOf(playWindow(ai)), null);
    for (const scope of [
      null,
      {},
      playWindow(ai, 2),
      playWindow(null),
      playWindow({ request: 1, onDelta: () => {} }),
    ]) {
      assert.equal(desktopAiOf(scope), null);
    }
  });

  it("calls through the bridge, streaming the ticket's text and letting go of its listener", async () => {
    const listeners = new Map<string, (text: unknown) => void>();
    const requests: Array<[string, unknown]> = [];
    const bridge = {
      async request(op: string, body: unknown) {
        requests.push([op, body]);
        if (op === AiBridgeOp.Hello) return { v: GAME_AI_WIRE_VERSION, on: true };
        if (op === AiBridgeOp.BudgetActive) return { view: GRANT, code: null };
        const ticket = ticketOf(body);
        listeners.get(ticket)?.("Hi");
        listeners.get(ticket)?.(42);
        return answered(ticket, "Hi there");
      },
      onDelta(ticket: string, listener: (text: unknown) => void) {
        listeners.set(ticket, listener);
        return () => listeners.delete(ticket);
      },
    };
    const transport = desktopTransport(desktopAiOf(playWindow(bridge)) ?? assert.fail("no bridge"));
    const { ai } = aiOn(hostLane(transport));
    await ai.ready();
    const ticket = ai.say({ site: "npc.line", prompt: "Greet." });
    const result = await nextResult(ai);
    assert.equal(result?.value, "Hi there");
    assert.equal(ticket.partial(), "Hi");
    assert.equal(listeners.size, 0);
    assert.deepEqual(
      requests.map(([op]) => op),
      [AiBridgeOp.Hello, AiBridgeOp.BudgetActive, AiBridgeOp.Call],
    );
  });

  it("fails a call the bridge throws on as door_unavailable", async () => {
    const bridge = {
      async request(op: string) {
        if (op === AiBridgeOp.Hello) return { v: GAME_AI_WIRE_VERSION, on: true };
        if (op === AiBridgeOp.BudgetActive) return { view: GRANT, code: null };
        throw new Error("gone");
      },
      onDelta: () => () => {},
    };
    const transport = desktopTransport(desktopAiOf(playWindow(bridge)) ?? assert.fail("no bridge"));
    const { ai } = aiOn(hostLane(transport));
    await ai.ready();
    ai.ask({ site: "npc.reply", prompt: "Greet.", schema: Line });
    assert.equal((await nextResult(ai))?.code, AiErrorCode.DoorUnavailable);
  });
});
