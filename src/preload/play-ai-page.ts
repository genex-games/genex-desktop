/**
 * `window.__genexDesktop` in a Play game's page. The Play view's preload (`play-mic.ts`) serializes
 * {@link installPlayAi} whole into the page before the game's own scripts run. It gives the page two
 * things and nothing else of the app: the embed-sdk 0.34 desktop path (`confirm`, from
 * `shared/genex-desktop-bridge.ts`), so the SDK asks Studio to draw Genex's card instead of opening
 * a popup, and the `genex-ai` host lane (`ai.request`, `ai.onDelta`). Each request leaves as a
 * numbered envelope through the preload's isolated world, which adds its own word on the person's
 * gesture; main decides everything. A request Play refused because it went to an AI vendor directly
 * is written to the page's console with its code. Type-only imports: at runtime the function may
 * use nothing from outside its body, so the wire values it needs come in as `words`.
 */
import type { PlayAiBlocked, PlayAiDelta, PlayAiReply } from "../shared/play-ai.ts";

// biome-ignore lint/suspicious/noExplicitAny: the untrusted page's own objects
type Foreign = any;

/** The wire values the page half needs, passed in because it cannot import them. */
export interface PlayAiPageWords {
  /** `GENEX_DESKTOP_GLOBAL`. */
  global: string;
  /** `GENEX_DESKTOP_BRIDGE_VERSION`. */
  version: number;
  /** `PlayBridgeOp.GenexConfirm`. */
  confirmOp: string;
  /** `AiBridgeOp.Call`: the op whose text streams, by its ticket. */
  callOp: string;
  /** `PLAY_AI_MAX_ENVELOPE_ID`. */
  maxId: number;
  /** The console's words beside an `ai_direct_blocked` code. */
  blockedNote: string;
  /** Why a request failed when the page has used up every envelope number. */
  exhausted: string;
}

/** What the preload drives: main's answers, streamed text and refusals, passed on to the page. */
export interface PlayAiControl {
  reply(reply: PlayAiReply): void;
  delta(delta: PlayAiDelta): void;
  blocked(blocked: PlayAiBlocked): void;
}

/**
 * Install the bridge on the page (`scope` is its global object). `send` hands one envelope to the
 * preload's isolated world; the answer takes what main says back, or is null when the page already
 * has a bridge.
 */
export function installPlayAi(
  send: (envelope: { id: number; op: string; body: unknown }) => void,
  words: PlayAiPageWords,
  scope: Foreign = globalThis,
): PlayAiControl | null {
  if (Object.hasOwn(scope, words.global)) return null;
  /** Each request waiting for main, by its envelope's number. */
  const waiting = new Map<number, (body: unknown) => void>();
  /** The ticket of each call waiting, by its envelope's number: its streamed text is the ticket's. */
  const tickets = new Map<number, string>();
  const listeners = new Map<string, Set<(text: string) => void>>();
  let last = 0;

  const post = (op: string, body: Foreign): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (last >= words.maxId) {
        reject(new Error(words.exhausted));
        return;
      }
      last += 1;
      const id = last;
      waiting.set(id, resolve);
      const ticket = op === words.callOp ? body?.ticket : undefined;
      if (typeof ticket === "string") tickets.set(id, ticket);
      try {
        send({ id, op, body });
      } catch (error) {
        waiting.delete(id);
        tickets.delete(id);
        reject(error);
      }
    });

  const onDelta = (ticket: string, listener: (text: string) => void): (() => void) => {
    if (typeof ticket !== "string" || typeof listener !== "function") return () => {};
    const set = listeners.get(ticket) ?? new Set<(text: string) => void>();
    set.add(listener);
    listeners.set(ticket, set);
    return () => {
      set.delete(listener);
      if (set.size === 0 && listeners.get(ticket) === set) listeners.delete(ticket);
    };
  };

  const ai = Object.freeze({ request: (op: string, body: unknown) => post(op, body), onDelta });
  const bridge = Object.freeze({
    version: words.version,
    confirm: (request: unknown) => post(words.confirmOp, request),
    ai,
  });
  Object.defineProperty(scope, words.global, {
    value: bridge,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  return {
    reply(reply: PlayAiReply): void {
      const id = reply?.id;
      const resolve = typeof id === "number" ? waiting.get(id) : undefined;
      if (!resolve) return;
      waiting.delete(id);
      tickets.delete(id);
      resolve(reply.body);
    },
    delta(delta: PlayAiDelta): void {
      const ticket = typeof delta?.id === "number" ? tickets.get(delta.id) : undefined;
      if (ticket === undefined || typeof delta.text !== "string") return;
      for (const listener of Array.from(listeners.get(ticket) ?? [])) {
        try {
          listener(delta.text);
        } catch {
          // A listener of the game's that throws is the game's own trouble; the others still hear.
        }
      }
    },
    blocked(blocked: PlayAiBlocked): void {
      scope.console?.error?.(blocked.code, words.blockedNote, blocked.host, blocked.vendor);
    },
  };
}
