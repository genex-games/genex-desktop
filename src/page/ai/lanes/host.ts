/**
 * The host lane: main on this Mac answers. In Create it is the Live route, a same-origin POST to
 * `<the game's origin>/__genex/ai/v1/<op>` (`AI_ROUTE_PREFIX`) with a `say` answer streamed as
 * server-sent events (`AiRouteEvent`); in Play it is the Play view's preload,
 * `window.__genexDesktop.ai`. Main derives the game and the context from where a message came
 * from and enforces everything; this lane only carries the op's body and reads the answer as
 * untrusted input, capped in size, so a broken bridge never hands the game a malformed value.
 */
import {
  AiBridgeOp,
  type AiCallAnswer,
  AiErrorCode,
  type AiGrantRequest,
  AI_MAX_OUTPUT_BYTES,
} from "../../../shared/game-ai.ts";
import {
  type AiBridgeBodies,
  type AiGrantAnswer,
  AI_ROUTE_PREFIX,
  AiRouteEvent,
} from "../../../shared/game-ai-bridge.ts";
import { AiLane } from "../../../shared/game-ai-lane.ts";
import { GENEX_DESKTOP_GLOBAL, genexDesktopBridgeOf } from "../../../shared/genex-desktop-bridge.ts";
import type { GenexDesktopAi } from "../../../shared/play-ai.ts";
import { readCallAnswer, readFlag, readGrantAnswer, readHello, readRouteRefusal } from "./answers.ts";
import { type Lane, type LaneCall, type LaneReply, noGrant, refusedReply } from "./lane.ts";
import type { FetchLike } from "./replay.ts";

/** The most bytes one answer body may hold: a whole answer and its JSON framing, twice over. */
export const HOST_MAX_ANSWER_BYTES = AI_MAX_OUTPUT_BYTES * 4;
/** The most bytes one streamed answer may hold, its deltas included. */
export const HOST_MAX_STREAM_BYTES = AI_MAX_OUTPUT_BYTES * 16;
const JSON_TYPE = "application/json";
const STREAM_TYPE = "text/event-stream";
const POST = "POST";

/** What one op sent to main came back as: its raw answer, or why there is none. */
export type HostSent = { ok: true; raw: unknown } | { ok: false; code: AiErrorCode };

/** How the host lane reaches main. */
export interface HostTransport {
  send<O extends AiBridgeOp>(
    op: O,
    body: AiBridgeBodies[O],
    options: { ticket?: string; onDelta?: (text: string) => void; signal?: AbortSignal },
  ): Promise<HostSent>;
}

const unreachable = (signal: AbortSignal | undefined): HostSent => ({
  ok: false,
  code: signal?.aborted ? AiErrorCode.Canceled : AiErrorCode.DoorUnavailable,
});

/** A body's bytes as text, at most `max` of them; null past the cap or on a broken body. */
async function cappedText(response: Response, max: number): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      bytes += next.value.byteLength;
      if (bytes > max) {
        await reader.cancel().catch(() => {});
        return null;
      }
      text += decoder.decode(next.value, { stream: true });
    }
    return text + decoder.decode();
  } catch {
    return null;
  }
}

function parsed(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** One server-sent event: its name and its data. */
interface StreamEvent {
  event: string;
  data: string;
}

/** The events in `block` (lines up to a blank one). */
function eventOf(block: string): StreamEvent | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  return data.length ? { event, data: data.join("\n") } : null;
}

/** A streamed answer: its deltas reported as they come, then the one reply. */
async function readStream(response: Response, onDelta: ((text: string) => void) | undefined): Promise<HostSent> {
  const reader = response.body?.getReader();
  if (!reader) return { ok: false, code: AiErrorCode.Provider };
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  try {
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      bytes += next.value.byteLength;
      if (bytes > HOST_MAX_STREAM_BYTES) break;
      buffer += decoder.decode(next.value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const event = eventOf(block);
        if (event?.event === AiRouteEvent.Reply) {
          await reader.cancel().catch(() => {});
          return { ok: true, raw: parsed(event.data) };
        }
        if (event?.event === AiRouteEvent.Delta) deliver(parsed(event.data), onDelta);
      }
    }
  } catch {
    return { ok: false, code: AiErrorCode.Provider };
  }
  await reader.cancel().catch(() => {});
  return { ok: false, code: AiErrorCode.Provider };
}

/** A delta's text, to the listener; anything else is dropped. */
function deliver(raw: unknown, onDelta: ((text: string) => void) | undefined): void {
  const text = typeof raw === "object" && raw !== null ? Reflect.get(raw, "text") : undefined;
  if (typeof text === "string") onDelta?.(text);
}

/** The Create Live route on the game's own origin. */
export function routeTransport(fetch: FetchLike): HostTransport {
  return {
    async send(op, body, { onDelta, signal }) {
      const streamed = op === AiBridgeOp.Call && onDelta !== undefined;
      let response: Response;
      try {
        response = await fetch(`${AI_ROUTE_PREFIX}${op}`, {
          method: POST,
          headers: { "content-type": JSON_TYPE, accept: streamed ? STREAM_TYPE : JSON_TYPE },
          body: JSON.stringify(body),
          credentials: "same-origin",
          cache: "no-store",
          ...(signal ? { signal } : {}),
        });
      } catch {
        return unreachable(signal);
      }
      if (response.status !== 200) {
        const code = readRouteRefusal(parsed(await cappedText(response, HOST_MAX_ANSWER_BYTES)));
        return { ok: false, code: code ?? AiErrorCode.DoorUnavailable };
      }
      if ((response.headers.get("content-type") ?? "").includes(STREAM_TYPE)) return readStream(response, onDelta);
      const text = await cappedText(response, HOST_MAX_ANSWER_BYTES);
      return text === null ? { ok: false, code: AiErrorCode.Provider } : { ok: true, raw: parsed(text) };
    },
  };
}

/** `window.__genexDesktop.ai` in a Play page, when the app installed it; null elsewhere. */
export function desktopAiOf(scope: unknown): GenexDesktopAi | null {
  if (!genexDesktopBridgeOf(scope) || typeof scope !== "object" || scope === null) return null;
  const bridge: unknown = Reflect.get(scope, GENEX_DESKTOP_GLOBAL);
  const ai: unknown = typeof bridge === "object" && bridge !== null ? Reflect.get(bridge, "ai") : null;
  if (typeof ai !== "object" || ai === null) return null;
  const request: unknown = Reflect.get(ai, "request");
  const onDelta: unknown = Reflect.get(ai, "onDelta");
  if (typeof request !== "function" || typeof onDelta !== "function") return null;
  return {
    request: (op, body) => Reflect.apply(request, ai, [op, body]),
    onDelta: (ticket, listener) => {
      const off: unknown = Reflect.apply(onDelta, ai, [ticket, listener]);
      return typeof off === "function" ? () => Reflect.apply(off, undefined, []) : () => {};
    },
  };
}

/** The Play view's preload. */
export function desktopTransport(ai: GenexDesktopAi): HostTransport {
  return {
    async send(op, body, { ticket, onDelta, signal }) {
      const listening = op === AiBridgeOp.Call && ticket !== undefined && onDelta !== undefined;
      const off = listening ? ai.onDelta(ticket, (text) => deliver({ text }, onDelta)) : () => {};
      try {
        return { ok: true, raw: await ai.request(op, body) };
      } catch {
        return unreachable(signal);
      } finally {
        off();
      }
    },
  };
}

/** A grant answer from main, or a refusal when it sent none that reads. */
function grantOf(sent: HostSent): AiGrantAnswer {
  if (!sent.ok) return noGrant(sent.code);
  return readGrantAnswer(sent.raw) ?? noGrant(AiErrorCode.DoorUnavailable);
}

/** One call to main: its answer read for its ticket, or a typed refusal. */
async function hostCall(transport: HostTransport, lane: LaneCall): Promise<LaneReply> {
  const { wire } = lane.call;
  const sent = await transport.send(AiBridgeOp.Call, wire, {
    ticket: wire.ticket,
    ...(wire.stream ? { onDelta: lane.onDelta } : {}),
    signal: lane.signal,
  });
  if (!sent.ok) return refusedReply(wire.ticket, sent.code, null);
  const answer: AiCallAnswer | null = readCallAnswer(sent.raw, wire.ticket);
  return answer ? { answer, frames: null, missed: false } : refusedReply(wire.ticket, AiErrorCode.Provider, null);
}

/** The host lane over a transport. */
export function hostLane(transport: HostTransport): Lane {
  const activeGrant = async () => grantOf(await transport.send(AiBridgeOp.BudgetActive, null, {}));
  return {
    lane: AiLane.Host,
    needsGrant: false,
    async open() {
      const hello = await transport.send(AiBridgeOp.Hello, null, {});
      const on = hello.ok && readHello(hello.raw) === true;
      return { on, grant: on ? await activeGrant() : noGrant(AiErrorCode.Off), tape: null };
    },
    call: (lane) => hostCall(transport, lane),
    cancel(ticket) {
      void transport.send(AiBridgeOp.Cancel, { ticket }, {});
    },
    activeGrant,
    requestGrant: async (request: AiGrantRequest) =>
      grantOf(await transport.send(AiBridgeOp.BudgetRequest, request, {})),
    async stopGrant() {
      const sent = await transport.send(AiBridgeOp.BudgetStop, null, {});
      return sent.ok && readFlag(sent.raw, "stopped");
    },
    reseed: () => {},
  };
}

/** Whether main's Create route answers here and says AI is on: a page Studio does not serve answers no. */
export async function routeIsOn(transport: HostTransport): Promise<boolean> {
  const hello = await transport.send(AiBridgeOp.Hello, null, {});
  return hello.ok && readHello(hello.raw) === true;
}
